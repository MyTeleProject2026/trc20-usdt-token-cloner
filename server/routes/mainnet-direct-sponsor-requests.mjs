import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { Trx } from 'tronweb'
import { createSponsorRoleFundingReader } from '../sponsor-roles.mjs'
import {
  MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS,
  OFFICIAL_MAINNET_USDT_CONTRACT as APPROVAL_USDT_CONTRACT,
  buildMainnetDirectSponsorApprovalMessage,
  mainnetDirectSponsorRequestSnapshotHash,
  resolveMainnetDirectSponsorApprovalPolicy,
  sha256Hex,
  verifyMainnetDirectSponsorApprovalSignature,
} from '../mainnet-direct-sponsor-approval.mjs'
import pg from 'pg'
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
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_direct_sponsor_approval_challenges (
            challenge_id TEXT PRIMARY KEY,
            request_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_requests(id),
            sponsor_address TEXT NOT NULL,
            origin TEXT NOT NULL,
            nonce_hash CHAR(64) NOT NULL UNIQUE,
            message_sha256 CHAR(64) NOT NULL,
            request_snapshot_sha256 CHAR(64) NOT NULL,
            organization_reference TEXT NOT NULL,
            agreement_reference TEXT NOT NULL,
            agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}      })().catch((error) => { schemaPromise = null; throw error })
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
    if (!result.rows[0]) return { success: false, reason: 'request-not-found' }
    const latest = await db.query(`
      SELECT sponsor_address, organization_reference, agreement_reference,
        agreement_sha256, message_sha256, approved_at, expires_at
      FROM trc20_token_clone.mainnet_direct_sponsor_approvals
      WHERE request_id = $1 ORDER BY approved_at DESC LIMIT 1
    `, [result.rows[0].id])
    const approval = latest.rows[0]
    return {
      success: true,
      request: publicRequest(result.rows[0]),
      sponsorApproval: approval ? {
        status: new Date(approval.expires_at).getTime() > Date.now() ? 'approved-active' : 'approved-expired',
        sponsorAddress: approval.sponsor_address,
        organizationReference: approval.organization_reference,
        agreementReference: approval.agreement_reference,
        agreementSha256: approval.agreement_sha256.trim(),
        messageSha256: approval.message_sha256.trim(),
        approvedAt: new Date(approval.approved_at).toISOString(),
        expiresAt: new Date(approval.expires_at).toISOString(),
      } : null,
    }
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

  async function createApprovalChallenge(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.idempotencyKey])
      const found = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE idempotency_key = $1 AND status = 'pending-sponsor-review'
        LIMIT 1 FOR UPDATE
      `, [input.idempotencyKey])
      const row = found.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-not-found-or-not-reviewable' }
      }
      if (BigInt(String(row.amount_base_units)) > BigInt(input.policy.maxUsdtBaseUnits)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-exceeds-sponsor-approval-cap' }
      }
      const activeApproval = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = $1 AND expires_at > $2
        ORDER BY approved_at DESC LIMIT 1
      `, [row.id, new Date(input.issuedAt)])
      if (activeApproval.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-already-has-active-sponsor-approval' }
      }
      const openChallenge = await client.query(`
        SELECT challenge_id FROM trc20_token_clone.mainnet_direct_sponsor_approval_challenges
        WHERE request_id = $1 AND sponsor_address = $2
          AND consumed_at IS NULL AND expires_at > $3
        LIMIT 1
      `, [row.id, input.sponsorAddress, new Date(input.issuedAt)])
      if (openChallenge.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'approval-challenge-already-open' }
      }
      await client.query(`
        INSERT INTO trc20_token_clone.mainnet_direct_sponsor_approval_challenges
          (challenge_id, request_id, sponsor_address, origin, nonce_hash, message_sha256,
           request_snapshot_sha256, organization_reference, agreement_reference,
           agreement_sha256, issued_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        input.challengeId, row.id, input.sponsorAddress, input.origin,
        input.nonceHash, input.messageSha256, input.requestSnapshotSha256,
        input.policy.organizationReference, input.policy.agreementReference,
        input.policy.agreementDocumentSha256, new Date(input.issuedAt), new Date(input.expiresAt),
      ])
      await client.query('COMMIT')
      return {
        success: true,
        challengeId: input.challengeId,
        request: publicRequest(row, { includeRequester: true }),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function consumeApprovalChallenge({ nonceHash, sponsorAddress, origin, nowMs }) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const consumed = await client.query(`
        UPDATE trc20_token_clone.mainnet_direct_sponsor_approval_challenges
        SET consumed_at = $4
        WHERE nonce_hash = $1 AND sponsor_address = $2 AND origin = $3
          AND consumed_at IS NULL AND expires_at > $4
        RETURNING *
      `, [nonceHash, sponsorAddress, origin, new Date(nowMs)])
      const challenge = consumed.rows[0]
      if (!challenge) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'approval-challenge-invalid-expired-or-replayed' }
      }
      const requestResult = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE id = $1 LIMIT 1
      `, [challenge.request_id])
      const request = requestResult.rows[0]
      if (!request || request.status !== 'pending-sponsor-review') {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-no-longer-reviewable' }
      }
      await client.query('COMMIT')
      return {
        success: true,
        challenge: {
          challengeId: challenge.challenge_id,
          sponsorAddress: challenge.sponsor_address,
          origin: challenge.origin,
          messageSha256: challenge.message_sha256.trim(),
          requestSnapshotSha256: challenge.request_snapshot_sha256.trim(),
          organizationReference: challenge.organization_reference,
          agreementReference: challenge.agreement_reference,
          agreementSha256: challenge.agreement_sha256.trim(),
          issuedAt: new Date(challenge.issued_at).toISOString(),
          expiresAt: new Date(challenge.expires_at).toISOString(),
          consumedAt: new Date(challenge.consumed_at).toISOString(),
          requestId: String(challenge.request_id),
        },
        request: publicRequest(request, { includeRequester: true }),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function recordSponsorApproval(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.requestId])
      const requestResult = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE id = $1 AND status = 'pending-sponsor-review'
        LIMIT 1 FOR UPDATE
      `, [input.requestId])
      if (!requestResult.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-no-longer-reviewable' }
      }
      const active = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = $1 AND expires_at > $2
        ORDER BY approved_at DESC LIMIT 1
      `, [input.requestId, new Date(input.approvedAt)])
      if (active.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-already-has-active-sponsor-approval' }
      }
      const challengeResult = await client.query(`
        SELECT challenge_id FROM trc20_token_clone.mainnet_direct_sponsor_approval_challenges
        WHERE challenge_id = $1 AND request_id = $2
          AND sponsor_address = $3 AND consumed_at IS NOT NULL
      `, [input.challengeId, input.requestId, input.sponsorAddress])
      if (!challengeResult.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'approval-challenge-not-consumed' }
      }
      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.mainnet_direct_sponsor_approvals
          (request_id, challenge_id, sponsor_address, organization_reference,
           agreement_reference, agreement_sha256, message_sha256, signature,
           approved_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id, request_id, sponsor_address, organization_reference,
          agreement_reference, agreement_sha256, message_sha256, approved_at, expires_at
      `, [
        input.requestId, input.challengeId, input.sponsorAddress,
        input.organizationReference, input.agreementReference, input.agreementSha256,
        input.messageSha256, input.signature, new Date(input.approvedAt), new Date(input.expiresAt),
      ])
      await client.query('COMMIT')
      const row = inserted.rows[0]
      return {
        success: true,
        approval: {
          id: String(row.id),
          requestId: String(row.request_id),
          sponsorAddress: row.sponsor_address,
          organizationReference: row.organization_reference,
          agreementReference: row.agreement_reference,
          agreementSha256: row.agreement_sha256.trim(),
          messageSha256: row.message_sha256.trim(),
          approvedAt: new Date(row.approved_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
        },
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error?.code === '23505') return { success: false, reason: 'request-already-has-active-sponsor-approval-or-challenge-replayed' }
      throw error
    } finally {
      client.release()
    }
  }

  async function listSponsorReviewQueue({ sponsorAddress, limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT r.*,
        latest.sponsor_address AS approved_sponsor_address,
        latest.organization_reference AS approved_organization_reference,
        latest.agreement_reference AS approved_agreement_reference,
        latest.approved_at,
        latest.expires_at AS approval_expires_at,
        latest.message_sha256 AS approval_message_sha256
      FROM trc20_token_clone.mainnet_direct_sponsor_requests r
      LEFT JOIN LATERAL (
        SELECT sponsor_address, organization_reference, agreement_reference,
          approved_at, expires_at, message_sha256
        FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = r.id
        ORDER BY approved_at DESC LIMIT 1
      ) latest ON true
      WHERE r.status = 'pending-sponsor-review'
      ORDER BY r.created_at ASC
      LIMIT $1
    `, [limit])
    const nowMs = Date.now()
    return {
      success: true,
      requests: result.rows.map((row) => ({
        ...publicRequest(row, { includeRequester: true }),
        sponsorApproval: row.approved_sponsor_address ? {
          status: new Date(row.approval_expires_at).getTime() > nowMs ? 'approved-active' : 'approved-expired',
          sponsorAddress: row.approved_sponsor_address,
          organizationReference: row.approved_organization_reference,
          agreementReference: row.approved_agreement_reference,
          approvedAt: new Date(row.approved_at).toISOString(),
          expiresAt: new Date(row.approval_expires_at).toISOString(),
          messageSha256: row.approval_message_sha256.trim(),
        } : { status: 'not-approved' },
      })),
    }
  }

  async function close() {
    if (!pool) return
    const currentPool = pool
    pool = null
    schemaPromise = null
    await currentPool.end()
  }

  return { createRequest, findRequest, listRequests, createApprovalChallenge, consumeApprovalChallenge, recordSponsorApproval, listSponsorReviewQueue, close }
}

export function createMainnetDirectSponsorRequestRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  store = createMainnetDirectSponsorRequestStore(env),
  readSponsorRoles = createSponsorRoleFundingReader({ env }),
  now = () => Date.now(),
  nonceFactory = () => randomBytes(32).toString('hex'),
  verifySponsorMessage = (message, signature) => Trx.verifyMessageV2(message, signature),
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

  async function authenticateMainnetSponsor(req) {
    const auth = await authenticateMainnetRequester(req)
    if (!auth.ok) return auth
    const policy = resolveMainnetDirectSponsorApprovalPolicy(env)
    if (!policy.configured) {
      return {
        ok: false,
        status: 503,
        error: 'mainnet-direct-sponsor-approval-policy-not-configured',
        requiredEnvironment: policy.missing,
      }
    }
    if (auth.session.address !== policy.sponsorAddress) {
      return {
        ok: false,
        status: 403,
        error: 'wallet-is-not-the-configured-mainnet-asset-principal-sponsor',
      }
    }
    return { ok: true, session: auth.session, policy }
  }

  function validateMainnetSponsorFunding(roleResult, request, policy, nowMs) {
    const blockers = []
    const checkedAt = Date.parse(roleResult?.checkedAt || '')
    if (roleResult?.success !== true || !Number.isFinite(checkedAt)
      || checkedAt > nowMs + 5_000 || nowMs - checkedAt > 15_000) {
      blockers.push('fresh-mainnet-sponsor-role-snapshot-required')
    }
    const roles = roleResult?.roles || {}
    const fee = roles.networkFeeSponsor || {}
    const principal = roles.assetPrincipalSponsor || {}
    if (principal.address !== policy.sponsorAddress || principal.onChainBalanceRead !== true
      || principal.tokenBalancesComplete !== true) {
      blockers.push('configured-asset-principal-balance-not-independently-verified')
    }
    const token = Array.isArray(principal.tokens) ? principal.tokens.find((item) =>
      item?.asset === 'USDT'
      && item?.tokenContract === OFFICIAL_MAINNET_USDT_CONTRACT
      && item?.status === 'verified'
      && item?.decimals === 6
      && /^[1-9][0-9]*$/.test(String(item?.balanceBaseUnits || ''))) : null
    if (!token || BigInt(token.balanceBaseUnits) < BigInt(request.amountBaseUnits)) {
      blockers.push('official-mainnet-usdt-sponsor-balance-does-not-cover-request')
    }
    if (!isValidTronAddress(fee.address) || fee.address === policy.sponsorAddress
      || roleResult?.configuredAddressesDistinct !== true) {
      blockers.push('distinct-mainnet-network-fee-sponsor-not-configured')
    }
    if (fee.onChainBalanceRead !== true || fee.native?.status !== 'verified'
      || fee.resourceStatus?.resourceRead !== true) {
      blockers.push('mainnet-network-fee-sponsor-funds-and-resources-not-verified')
    }
    return { ready: blockers.length === 0, blockers }
  }

  router.get('/sponsorship/mainnet-direct/review-queue', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error,
      ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      sponsorApprovalEnabled: false, canSubmitSponsoredTransfer: false,
    })
    const rawLimit = req.query?.limit === undefined ? '50' : String(req.query.limit)
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) {
      return res.status(400).json({ success: false, error: 'invalid-limit', canSubmitSponsoredTransfer: false })
    }
    try {
      const result = await store.listSponsorReviewQueue({
        sponsorAddress: auth.policy.sponsorAddress,
        limit: Number(rawLimit),
      })
      if (result?.success !== true) return res.status(503).json({
        success: false, error: result?.reason || 'sponsor-review-queue-unavailable',
        canSubmitSponsoredTransfer: false,
      })
      return res.json({
        success: true,
        status: 'sponsor-review-queue-loaded',
        sponsorAddress: auth.policy.sponsorAddress,
        organizationReference: auth.policy.organizationReference,
        requests: result.requests,
        count: result.requests.length,
        sponsorApprovalEnabled: true,
        canCreateSigningIntent: false,
        canSubmitSponsoredTransfer: false,
        transactionBroadcast: false,
        message: 'This queue permits request-specific principal approval only. It does not reserve funds, approve network fees, create a transaction, or enable Mainnet execution.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-review-queue-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.post('/sponsorship/mainnet-direct/requests/:idempotencyKey/approval-challenge', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error,
      ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)) {
      return res.status(400).json({ success: false, error: 'invalid-idempotency-key', canSubmitSponsoredTransfer: false })
    }

    try {
      const requestResult = await store.findRequestForSponsor?.(key)
        ?? await store.findRequest(key, auth.policy.sponsorAddress).catch(() => null)
      if (!requestResult?.success || !requestResult.request) {
        return res.status(requestResult?.reason === 'request-not-found' ? 404 : 409).json({
          success: false, error: requestResult?.reason || 'sponsor-request-not-found',
          canSubmitSponsoredTransfer: false,
        })
      }
      const request = requestResult.request
      if (request.status !== 'pending-sponsor-review' || request.network !== 'mainnet'
        || request.asset !== 'USDT' || request.tokenContract !== OFFICIAL_MAINNET_USDT_CONTRACT) {
        return res.status(409).json({ success: false, error: 'request-not-eligible-for-mainnet-sponsor-approval' })
      }
      if (BigInt(request.amountBaseUnits) > BigInt(auth.policy.maxUsdtBaseUnits)) {
        return res.status(409).json({ success: false, error: 'request-exceeds-sponsor-approval-cap' })
      }

      const roleResult = await readSponsorRoles('mainnet', { refresh: true })
      const funding = validateMainnetSponsorFunding(roleResult, request, auth.policy, now())
      if (!funding.ready) {
        return res.status(409).json({
          success: false,
          error: 'mainnet-sponsor-funding-preflight-blocked',
          blockers: funding.blockers,
          canCreateSigningIntent: false,
          canSubmitSponsoredTransfer: false,
        })
      }

      const nonce = nonceFactory()
      if (typeof nonce !== 'string' || !/^[0-9a-f]{48,128}$/i.test(nonce)) {
        return res.status(503).json({ success: false, error: 'approval-challenge-randomness-unavailable' })
      }
      const issuedAtMs = now()
      const expiresAtMs = issuedAtMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS
      const issuedAt = new Date(issuedAtMs).toISOString()
      const expiresAt = new Date(expiresAtMs).toISOString()
      const message = buildMainnetDirectSponsorApprovalMessage({
        request,
        policy: auth.policy,
        nonce,
        issuedAt,
        expiresAt,
      })
      const challengeId = randomBytes(24).toString('hex')
      const stored = await store.createApprovalChallenge({
        idempotencyKey: key,
        sponsorAddress: auth.policy.sponsorAddress,
        origin: req.get('origin'),
        nonceHash: sha256Hex(nonce),
        messageSha256: sha256Hex(message),
        requestSnapshotSha256: mainnetDirectSponsorRequestSnapshotHash(request),
        challengeId,
        policy: auth.policy,
        issuedAt,
        expiresAt,
      })
      if (stored?.success !== true) {
        const status = stored?.reason === 'request-not-found-or-not-reviewable' ? 404 : 409
        return res.status(status).json({
          success: false, error: stored?.reason || 'approval-challenge-not-created',
          canCreateSigningIntent: false, canSubmitSponsoredTransfer: false,
        })
      }
      return res.status(201).json({
        success: true,
        status: 'sponsor-approval-signature-required',
        challengeId,
        nonce,
        message,
        request: stored.request,
        sponsorAddress: auth.policy.sponsorAddress,
        organizationReference: auth.policy.organizationReference,
        expiresAt,
        sponsorApprovalRecorded: false,
        signingIntentCreated: false,
        canSubmitSponsoredTransfer: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'approval-challenge-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.post('/sponsorship/mainnet-direct/requests/:idempotencyKey/approve', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error,
      ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const key = req.params?.idempotencyKey
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)
      || Object.keys(body).some((field) => !['nonce', 'signature'].includes(field))
      || typeof body.nonce !== 'string' || !/^[0-9a-f]{48,128}$/i.test(body.nonce)
      || typeof body.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-approval-signature-payload', canSubmitSponsoredTransfer: false })
    }
    try {
      const consumed = await store.consumeApprovalChallenge({
        nonceHash: sha256Hex(body.nonce),
        sponsorAddress: auth.policy.sponsorAddress,
        origin: req.get('origin'),
        nowMs: now(),
      })
      if (consumed?.success !== true) {
        return res.status(409).json({
          success: false,
          error: consumed?.reason || 'approval-challenge-invalid-expired-or-replayed',
          canSubmitSponsoredTransfer: false,
        })
      }
      const challenge = consumed.challenge
      const request = consumed.request
      if (request.idempotencyKey !== key
        || challenge.sponsorAddress !== auth.policy.sponsorAddress
        || challenge.organizationReference !== auth.policy.organizationReference
        || challenge.agreementReference !== auth.policy.agreementReference
        || challenge.agreementSha256 !== auth.policy.agreementDocumentSha256
        || challenge.requestSnapshotSha256 !== mainnetDirectSponsorRequestSnapshotHash(request)) {
        return res.status(409).json({ success: false, error: 'approval-challenge-request-or-policy-mismatch', canSubmitSponsoredTransfer: false })
      }
      const message = buildMainnetDirectSponsorApprovalMessage({
        request,
        policy: auth.policy,
        nonce: body.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      })
      const messageSha256 = sha256Hex(message)
      if (messageSha256 !== challenge.messageSha256) {
        return res.status(409).json({ success: false, error: 'approval-message-digest-mismatch', canSubmitSponsoredTransfer: false })
      }
      const verified = await verifyMainnetDirectSponsorApprovalSignature({
        message,
        signature: body.signature,
        expectedSponsorAddress: auth.policy.sponsorAddress,
        nowMs: now(),
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        verifyMessage: verifySponsorMessage,
      })
      if (verified?.verified !== true) {
        return res.status(401).json({
          success: false, error: verified?.reason || 'sponsor-approval-signature-invalid',
          challengeConsumed: true, canSubmitSponsoredTransfer: false,
        })
      }
      const approvedAtMs = now()
      const approvalExpiresAt = new Date(approvedAtMs + 30 * 60 * 1000).toISOString()
      const recorded = await store.recordSponsorApproval({
        requestId: request.id,
        challengeId: challenge.challengeId,
        sponsorAddress: auth.policy.sponsorAddress,
        organizationReference: auth.policy.organizationReference,
        agreementReference: auth.policy.agreementReference,
        agreementSha256: auth.policy.agreementDocumentSha256,
        messageSha256,
        signature: body.signature,
        approvedAt: new Date(approvedAtMs).toISOString(),
        expiresAt: approvalExpiresAt,
      })
      if (recorded?.success !== true) return res.status(409).json({
        success: false, error: recorded?.reason || 'sponsor-approval-not-recorded',
        canSubmitSponsoredTransfer: false,
      })
      return res.json({
        success: true,
        status: 'sponsor-approved-principal-only',
        request,
        sponsorApproval: recorded.approval,
        sponsorApproved: true,
        feeSponsorApproval: false,
        budgetReserved: false,
        signingIntentCreated: false,
        canCreateSigningIntent: false,
        canSubmitSponsoredTransfer: false,
        transactionBroadcast: false,
        unpaidFallbackToUserFunds: false,
        message: 'The configured asset-principal sponsor signed approval for this exact USDT request. This records approval only; network-fee approval, reservation, transaction signing, broadcast and settlement remain disabled.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-approval-verification-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

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
      return res.json({
        success: true,
        request: result.request,
        sponsorApproved: result.sponsorApproval?.status === 'approved-active',
        sponsorApproval: result.sponsorApproval,
        feeSponsorApproved: false,
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

  return router
}

export default createMainnetDirectSponsorRequestRouter()
),
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_sponsor_approval_challenges_request_idx
          ON trc20_token_clone.mainnet_direct_sponsor_approval_challenges (request_id, expires_at DESC)
        `)
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_direct_sponsor_approvals (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            request_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_requests(id),
            challenge_id TEXT NOT NULL UNIQUE REFERENCES trc20_token_clone.mainnet_direct_sponsor_approval_challenges(challenge_id),
            sponsor_address TEXT NOT NULL,
            organization_reference TEXT NOT NULL,
            agreement_reference TEXT NOT NULL,
            agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}      })().catch((error) => { schemaPromise = null; throw error })
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
      return res.json({
        success: true,
        request: result.request,
        sponsorApproved: false,
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

  return router
}

export default createMainnetDirectSponsorRequestRouter()
),
            message_sha256 CHAR(64) NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}      })().catch((error) => { schemaPromise = null; throw error })
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
      return res.json({
        success: true,
        request: result.request,
        sponsorApproved: false,
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

  return router
}

export default createMainnetDirectSponsorRequestRouter()
),
            signature TEXT NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]{130}      })().catch((error) => { schemaPromise = null; throw error })
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
      return res.json({
        success: true,
        request: result.request,
        sponsorApproved: false,
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

  return router
}

export default createMainnetDirectSponsorRequestRouter()
),
            approved_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_sponsor_approvals_request_idx
          ON trc20_token_clone.mainnet_direct_sponsor_approvals (request_id, approved_at DESC)
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
      return res.json({
        success: true,
        request: result.request,
        sponsorApproved: false,
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

  return router
}

export default createMainnetDirectSponsorRequestRouter()
