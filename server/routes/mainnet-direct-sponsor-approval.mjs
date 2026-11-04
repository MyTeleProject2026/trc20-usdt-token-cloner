import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { Trx } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { createSponsorRoleFundingReader } from '../sponsor-roles.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import {
  MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS,
  OFFICIAL_MAINNET_USDT_CONTRACT,
  buildMainnetDirectSponsorApprovalMessage,
  buildMainnetDirectFeeSponsorApprovalMessage,
  mainnetDirectSponsorRequestSnapshotHash,
  resolveMainnetDirectFeeApprovalPolicy,
  resolveMainnetDirectSponsorApprovalPolicy,
  sha256Hex,
  verifyMainnetDirectSponsorApprovalSignature,
} from '../mainnet-direct-sponsor-approval.mjs'

const { Pool } = pg
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/
const NONCE_PATTERN = /^[0-9a-f]{48,128}$/i
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Origin, Authorization')
}

function bearerToken(req) {
  const header = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)
  return match ? match[1] : ''
}

function publicRequest(row) {
  return {
    id: String(row.id),
    idempotencyKey: row.idempotency_key,
    requesterAddress: row.requester_address,
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

function latestApproval(row, nowMs) {
  if (!row) return { status: 'not-approved' }
  return {
    status: new Date(row.expires_at).getTime() > nowMs ? 'approved-active' : 'approved-expired',
    sponsorAddress: row.sponsor_address,
    organizationReference: row.organization_reference,
    agreementReference: row.agreement_reference,
    agreementSha256: row.agreement_sha256.trim(),
    messageSha256: row.message_sha256.trim(),
    ...(row.max_fee_sun !== undefined ? { maxFeeSun: String(row.max_fee_sun) } : {}),
    approvedAt: new Date(row.approved_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

export function createMainnetDirectSponsorApprovalStore(env = process.env) {
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
    pool.on('error', (error) => console.error('Mainnet sponsor approval database error:', error?.code || 'unknown'))
    return pool
  }

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
        // The sponsor review queue may be opened before the first user request.
        // Ensure its referenced request table exists before creating approval foreign keys.
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
            status TEXT NOT NULL DEFAULT 'pending-sponsor-review' CHECK (status = 'pending-sponsor-review'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_sponsor_requests_owner_idx
          ON trc20_token_clone.mainnet_direct_sponsor_requests (requester_address, created_at DESC)
        `)
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_direct_sponsor_approval_challenges (
            challenge_id TEXT PRIMARY KEY,
            request_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_requests(id),
            sponsor_address TEXT NOT NULL,
            origin TEXT NOT NULL,
            nonce_hash CHAR(64) NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
            message_sha256 CHAR(64) NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
            request_snapshot_sha256 CHAR(64) NOT NULL CHECK (request_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
            organization_reference TEXT NOT NULL,
            agreement_reference TEXT NOT NULL,
            agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (expires_at > issued_at)
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
            agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
            message_sha256 CHAR(64) NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
            signature TEXT NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]{130}$'),
            approved_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (expires_at > approved_at)
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_sponsor_approvals_request_idx
          ON trc20_token_clone.mainnet_direct_sponsor_approvals (request_id, approved_at DESC)
        `)
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_direct_fee_approval_challenges (
            challenge_id TEXT PRIMARY KEY,
            request_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_requests(id),
            principal_approval_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_approvals(id),
            sponsor_address TEXT NOT NULL,
            origin TEXT NOT NULL,
            nonce_hash CHAR(64) NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
            message_sha256 CHAR(64) NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
            request_snapshot_sha256 CHAR(64) NOT NULL CHECK (request_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
            organization_reference TEXT NOT NULL,
            agreement_reference TEXT NOT NULL,
            agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
            max_fee_sun NUMERIC(78,0) NOT NULL CHECK (max_fee_sun > 0),
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (expires_at > issued_at)
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_fee_approval_challenges_request_idx
          ON trc20_token_clone.mainnet_direct_fee_approval_challenges (request_id, expires_at DESC)
        `)
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_direct_fee_approvals (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            request_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_requests(id),
            principal_approval_id BIGINT NOT NULL REFERENCES trc20_token_clone.mainnet_direct_sponsor_approvals(id),
            challenge_id TEXT NOT NULL UNIQUE REFERENCES trc20_token_clone.mainnet_direct_fee_approval_challenges(challenge_id),
            sponsor_address TEXT NOT NULL,
            organization_reference TEXT NOT NULL,
            agreement_reference TEXT NOT NULL,
            agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
            message_sha256 CHAR(64) NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
            signature TEXT NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]{130}$'),
            max_fee_sun NUMERIC(78,0) NOT NULL CHECK (max_fee_sun > 0),
            approved_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (expires_at > approved_at)
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_fee_approvals_request_idx
          ON trc20_token_clone.mainnet_direct_fee_approvals (request_id, approved_at DESC)
        `)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  async function findRequestForSponsor(idempotencyKey) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
      WHERE idempotency_key = $1 AND status = 'pending-sponsor-review' LIMIT 1
    `, [idempotencyKey])
    return result.rows[0]
      ? { success: true, request: publicRequest(result.rows[0]) }
      : { success: false, reason: 'request-not-found' }
  }

  async function findApprovalsForOwner(idempotencyKey, requesterAddress) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const request = await db.query(`
      SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_requests
      WHERE idempotency_key = $1 AND requester_address = $2 LIMIT 1
    `, [idempotencyKey, requesterAddress])
    if (!request.rows[0]) return { success: false, reason: 'request-not-found' }
    const [principal, fee] = await Promise.all([
      db.query(`
        SELECT sponsor_address, organization_reference, agreement_reference,
          agreement_sha256, message_sha256, approved_at, expires_at
        FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = $1 ORDER BY approved_at DESC LIMIT 1
      `, [request.rows[0].id]),
      db.query(`
        SELECT sponsor_address, organization_reference, agreement_reference,
          agreement_sha256, message_sha256, max_fee_sun::text AS max_fee_sun,
          approved_at, expires_at
        FROM trc20_token_clone.mainnet_direct_fee_approvals
        WHERE request_id = $1 ORDER BY approved_at DESC LIMIT 1
      `, [request.rows[0].id]),
    ])
    return {
      success: true,
      sponsorApproval: latestApproval(principal.rows[0], Date.now()),
      feeSponsorApproval: latestApproval(fee.rows[0], Date.now()),
    }
  }

  async function createApprovalChallenge(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.idempotencyKey])
      const request = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE idempotency_key = $1 AND status = 'pending-sponsor-review' LIMIT 1 FOR UPDATE
      `, [input.idempotencyKey])
      const row = request.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-not-found-or-not-reviewable' }
      }
      if (BigInt(String(row.amount_base_units)) > BigInt(input.policy.maxUsdtBaseUnits)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-exceeds-sponsor-approval-cap' }
      }
      const active = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = $1 AND expires_at > $2 ORDER BY approved_at DESC LIMIT 1
      `, [row.id, new Date(input.issuedAt)])
      if (active.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-already-has-active-sponsor-approval' }
      }
      const open = await client.query(`
        SELECT challenge_id FROM trc20_token_clone.mainnet_direct_sponsor_approval_challenges
        WHERE request_id = $1 AND sponsor_address = $2
          AND consumed_at IS NULL AND expires_at > $3 LIMIT 1
      `, [row.id, input.sponsorAddress, new Date(input.issuedAt)])
      if (open.rows.length) {
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
        input.challengeId, row.id, input.sponsorAddress, input.origin, input.nonceHash,
        input.messageSha256, input.requestSnapshotSha256, input.policy.organizationReference,
        input.policy.agreementReference, input.policy.agreementDocumentSha256,
        new Date(input.issuedAt), new Date(input.expiresAt),
      ])
      await client.query('COMMIT')
      return { success: true, challengeId: input.challengeId, request: publicRequest(row) }
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
      const result = await client.query(`
        UPDATE trc20_token_clone.mainnet_direct_sponsor_approval_challenges
        SET consumed_at = $4
        WHERE nonce_hash = $1 AND sponsor_address = $2 AND origin = $3
          AND consumed_at IS NULL AND expires_at > $4
        RETURNING *
      `, [nonceHash, sponsorAddress, origin, new Date(nowMs)])
      const challenge = result.rows[0]
      if (!challenge) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'approval-challenge-invalid-expired-or-replayed' }
      }
      const request = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE id = $1 AND status = 'pending-sponsor-review' LIMIT 1
      `, [challenge.request_id])
      if (!request.rows[0]) {
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
        request: publicRequest(request.rows[0]),
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
      const request = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE id = $1 AND status = 'pending-sponsor-review' LIMIT 1 FOR UPDATE
      `, [input.requestId])
      if (!request.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-no-longer-reviewable' }
      }
      const active = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = $1 AND expires_at > $2 LIMIT 1
      `, [input.requestId, new Date(input.approvedAt)])
      if (active.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-already-has-active-sponsor-approval' }
      }
      const challenge = await client.query(`
        SELECT 1 FROM trc20_token_clone.mainnet_direct_sponsor_approval_challenges
        WHERE challenge_id = $1 AND request_id = $2 AND sponsor_address = $3 AND consumed_at IS NOT NULL
      `, [input.challengeId, input.requestId, input.sponsorAddress])
      if (!challenge.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'approval-challenge-not-consumed' }
      }
      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.mainnet_direct_sponsor_approvals
          (request_id, challenge_id, sponsor_address, organization_reference, agreement_reference,
           agreement_sha256, message_sha256, signature, approved_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id, request_id, sponsor_address, organization_reference, agreement_reference,
          agreement_sha256, message_sha256, approved_at, expires_at
      `, [
        input.requestId, input.challengeId, input.sponsorAddress, input.organizationReference,
        input.agreementReference, input.agreementSha256, input.messageSha256, input.signature,
        new Date(input.approvedAt), new Date(input.expiresAt),
      ])
      await client.query('COMMIT')
      const row = inserted.rows[0]
      return { success: true, approval: {
        id: String(row.id), requestId: String(row.request_id),
        sponsorAddress: row.sponsor_address, organizationReference: row.organization_reference,
        agreementReference: row.agreement_reference, agreementSha256: row.agreement_sha256.trim(),
        messageSha256: row.message_sha256.trim(), approvedAt: new Date(row.approved_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      } }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error?.code === '23505') return { success: false, reason: 'request-already-has-active-sponsor-approval-or-challenge-replayed' }
      throw error
    } finally {
      client.release()
    }
  }

  async function listSponsorReviewQueue({ limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT r.*,
        a.sponsor_address AS sponsor_address_approved,
        a.organization_reference AS sponsor_org_ref,
        a.agreement_reference AS sponsor_agreement_ref,
        a.message_sha256 AS sponsor_message_sha,
        a.approved_at AS sponsor_approved_at,
        a.expires_at AS sponsor_expires_at
      FROM trc20_token_clone.mainnet_direct_sponsor_requests r
      LEFT JOIN LATERAL (
        SELECT sponsor_address, organization_reference, agreement_reference, message_sha256, approved_at, expires_at
        FROM trc20_token_clone.mainnet_direct_sponsor_approvals WHERE request_id = r.id
        ORDER BY approved_at DESC LIMIT 1
      ) a ON true
      WHERE r.status = 'pending-sponsor-review'
      ORDER BY r.created_at ASC LIMIT $1
    `, [limit])
    const nowMs = Date.now()
    return { success: true, requests: result.rows.map(row => ({
      ...publicRequest(row),
      sponsorApproval: row.sponsor_address_approved ? {
        status: new Date(row.sponsor_expires_at).getTime() > nowMs ? 'approved-active' : 'approved-expired',
        sponsorAddress: row.sponsor_address_approved, organizationReference: row.sponsor_org_ref,
        agreementReference: row.sponsor_agreement_ref, messageSha256: row.sponsor_message_sha.trim(),
        approvedAt: new Date(row.sponsor_approved_at).toISOString(), expiresAt: new Date(row.sponsor_expires_at).toISOString(),
      } : { status: 'not-approved' },
    })) }
  }

  async function createFeeApprovalChallenge(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.idempotencyKey])
      const request = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE idempotency_key = $1 AND status = 'pending-sponsor-review' LIMIT 1 FOR UPDATE
      `, [input.idempotencyKey])
      const row = request.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-not-found-or-not-reviewable' }
      }
      const principal = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = $1 AND expires_at > $2 ORDER BY approved_at DESC LIMIT 1
      `, [row.id, new Date(input.issuedAt)])
      if (!principal.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'active-asset-principal-approval-required-before-fee-approval' }
      }
      const activeFee = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_fee_approvals
        WHERE request_id = $1 AND expires_at > $2 LIMIT 1
      `, [row.id, new Date(input.issuedAt)])
      if (activeFee.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-already-has-active-fee-sponsor-approval' }
      }
      const open = await client.query(`
        SELECT challenge_id FROM trc20_token_clone.mainnet_direct_fee_approval_challenges
        WHERE request_id = $1 AND sponsor_address = $2
          AND consumed_at IS NULL AND expires_at > $3 LIMIT 1
      `, [row.id, input.sponsorAddress, new Date(input.issuedAt)])
      if (open.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'fee-approval-challenge-already-open' }
      }
      await client.query(`
        INSERT INTO trc20_token_clone.mainnet_direct_fee_approval_challenges
          (challenge_id, request_id, principal_approval_id, sponsor_address, origin,
           nonce_hash, message_sha256, request_snapshot_sha256, organization_reference,
           agreement_reference, agreement_sha256, max_fee_sun, issued_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [
        input.challengeId, row.id, principal.rows[0].id, input.sponsorAddress, input.origin,
        input.nonceHash, input.messageSha256, input.requestSnapshotSha256, input.feePolicy.organizationReference,
        input.feePolicy.agreementReference, input.feePolicy.agreementDocumentSha256, input.feePolicy.maxFeeSun,
        new Date(input.issuedAt), new Date(input.expiresAt),
      ])
      await client.query('COMMIT')
      return { success: true, challengeId: input.challengeId, request: publicRequest(row), principalApprovalId: String(principal.rows[0].id) }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function consumeFeeApprovalChallenge({ nonceHash, sponsorAddress, origin, nowMs }) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(`
        UPDATE trc20_token_clone.mainnet_direct_fee_approval_challenges
        SET consumed_at = $4
        WHERE nonce_hash = $1 AND sponsor_address = $2 AND origin = $3
          AND consumed_at IS NULL AND expires_at > $4 RETURNING *
      `, [nonceHash, sponsorAddress, origin, new Date(nowMs)])
      const challenge = result.rows[0]
      if (!challenge) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'fee-approval-challenge-invalid-expired-or-replayed' }
      }
      const request = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE id = $1 AND status = 'pending-sponsor-review' LIMIT 1
      `, [challenge.request_id])
      const principal = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE id = $1 AND request_id = $2 AND expires_at > $3 LIMIT 1
      `, [challenge.principal_approval_id, challenge.request_id, new Date(nowMs)])
      if (!request.rows[0] || !principal.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'active-asset-principal-approval-no-longer-valid' }
      }
      await client.query('COMMIT')
      return {
        success: true,
        challenge: {
          challengeId: challenge.challenge_id, sponsorAddress: challenge.sponsor_address,
          origin: challenge.origin, messageSha256: challenge.message_sha256.trim(),
          requestSnapshotSha256: challenge.request_snapshot_sha256.trim(),
          organizationReference: challenge.organization_reference, agreementReference: challenge.agreement_reference,
          agreementSha256: challenge.agreement_sha256.trim(), maxFeeSun: String(challenge.max_fee_sun),
          issuedAt: new Date(challenge.issued_at).toISOString(), expiresAt: new Date(challenge.expires_at).toISOString(),
          consumedAt: new Date(challenge.consumed_at).toISOString(), requestId: String(challenge.request_id),
          principalApprovalId: String(challenge.principal_approval_id),
        },
        request: publicRequest(request.rows[0]),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function recordFeeSponsorApproval(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.requestId])
      const request = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE id = $1 AND status = 'pending-sponsor-review' LIMIT 1 FOR UPDATE
      `, [input.requestId])
      if (!request.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-no-longer-reviewable' }
      }
      const principal = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE id = $1 AND request_id = $2 AND expires_at > $3 LIMIT 1
      `, [input.principalApprovalId, input.requestId, new Date(input.approvedAt)])
      if (!principal.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'active-asset-principal-approval-required' }
      }
      const activeFee = await client.query(`
        SELECT id FROM trc20_token_clone.mainnet_direct_fee_approvals
        WHERE request_id = $1 AND expires_at > $2 LIMIT 1
      `, [input.requestId, new Date(input.approvedAt)])
      if (activeFee.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-already-has-active-fee-sponsor-approval' }
      }
      const challenge = await client.query(`
        SELECT 1 FROM trc20_token_clone.mainnet_direct_fee_approval_challenges
        WHERE challenge_id = $1 AND request_id = $2 AND principal_approval_id = $3
          AND sponsor_address = $4 AND consumed_at IS NOT NULL
      `, [input.challengeId, input.requestId, input.principalApprovalId, input.sponsorAddress])
      if (!challenge.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'fee-approval-challenge-not-consumed' }
      }
      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.mainnet_direct_fee_approvals
          (request_id, principal_approval_id, challenge_id, sponsor_address,
           organization_reference, agreement_reference, agreement_sha256,
           message_sha256, signature, max_fee_sun, approved_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id, request_id, principal_approval_id, sponsor_address,
          organization_reference, agreement_reference, agreement_sha256,
          message_sha256, max_fee_sun::text AS max_fee_sun, approved_at, expires_at
      `, [
        input.requestId, input.principalApprovalId, input.challengeId, input.sponsorAddress,
        input.organizationReference, input.agreementReference, input.agreementSha256,
        input.messageSha256, input.signature, input.maxFeeSun,
        new Date(input.approvedAt), new Date(input.expiresAt),
      ])
      await client.query('COMMIT')
      const row = inserted.rows[0]
      return { success: true, approval: {
        id: String(row.id), requestId: String(row.request_id), principalApprovalId: String(row.principal_approval_id),
        sponsorAddress: row.sponsor_address, organizationReference: row.organization_reference,
        agreementReference: row.agreement_reference, agreementSha256: row.agreement_sha256.trim(),
        messageSha256: row.message_sha256.trim(), maxFeeSun: row.max_fee_sun,
        approvedAt: new Date(row.approved_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
      } }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error?.code === '23505') return { success: false, reason: 'request-already-has-active-fee-approval-or-challenge-replayed' }
      throw error
    } finally {
      client.release()
    }
  }

  async function listFeeSponsorReviewQueue({ limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT r.*,
        pa.id AS principal_approval_id, pa.sponsor_address AS principal_sponsor_address,
        pa.expires_at AS principal_approval_expires_at,
        fa.sponsor_address AS fee_sponsor_address, fa.organization_reference AS fee_organization_reference,
        fa.agreement_reference AS fee_agreement_reference, fa.max_fee_sun::text AS fee_max_fee_sun,
        fa.approved_at AS fee_approved_at, fa.expires_at AS fee_approval_expires_at,
        fa.message_sha256 AS fee_message_sha256
      FROM trc20_token_clone.mainnet_direct_sponsor_requests r
      LEFT JOIN LATERAL (
        SELECT id, sponsor_address, expires_at FROM trc20_token_clone.mainnet_direct_sponsor_approvals
        WHERE request_id = r.id ORDER BY approved_at DESC LIMIT 1
      ) pa ON true
      LEFT JOIN LATERAL (
        SELECT sponsor_address, organization_reference, agreement_reference, max_fee_sun,
          approved_at, expires_at, message_sha256 FROM trc20_token_clone.mainnet_direct_fee_approvals
        WHERE request_id = r.id ORDER BY approved_at DESC LIMIT 1
      ) fa ON true
      WHERE r.status = 'pending-sponsor-review'
      ORDER BY r.created_at ASC LIMIT $1
    `, [limit])
    const nowMs = Date.now()
    return { success: true, requests: result.rows.map(row => ({
      ...publicRequest(row),
      sponsorApproval: row.principal_approval_id ? {
        status: new Date(row.principal_approval_expires_at).getTime() > nowMs ? 'approved-active' : 'approved-expired',
        sponsorAddress: row.principal_sponsor_address,
      } : { status: 'not-approved' },
      feeSponsorApproval: row.fee_sponsor_address ? {
        status: new Date(row.fee_approval_expires_at).getTime() > nowMs ? 'approved-active' : 'approved-expired',
        sponsorAddress: row.fee_sponsor_address, organizationReference: row.fee_organization_reference,
        agreementReference: row.fee_agreement_reference, maxFeeSun: row.fee_max_fee_sun,
        approvedAt: new Date(row.fee_approved_at).toISOString(),
        expiresAt: new Date(row.fee_approval_expires_at).toISOString(),
        messageSha256: row.fee_message_sha256.trim(),
      } : { status: 'not-approved' },
    })) }
  }

  async function close() {
    if (!pool) return
    const currentPool = pool
    pool = null
    schemaPromise = null
    await currentPool.end()
  }

  return {
    findRequestForSponsor, findApprovalsForOwner, createApprovalChallenge,
    consumeApprovalChallenge, recordSponsorApproval, listSponsorReviewQueue,
    createFeeApprovalChallenge, consumeFeeApprovalChallenge, recordFeeSponsorApproval,
    listFeeSponsorReviewQueue, close,
  }
}

export function createMainnetDirectSponsorApprovalRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  store = createMainnetDirectSponsorApprovalStore(env),
  readSponsorRoles = createSponsorRoleFundingReader({ env }),
  now = () => Date.now(),
  nonceFactory = () => randomBytes(32).toString('hex'),
  verifySponsorMessage = (message, signature) => Trx.verifyMessageV2(message, signature),
} = {}) {
  const router = Router()

  async function authenticateMainnetIdentity(req) {
    const token = bearerToken(req)
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
        || !isValidTronAddress(session.address) || !Number.isFinite(session.expiresAt)
        || session.expiresAt <= now()) {
        return { ok: false, status: 403, error: 'mainnet-wallet-session-required' }
      }
      return { ok: true, session }
    } catch {
      return { ok: false, status: 503, error: 'wallet-session-verification-unavailable' }
    }
  }

  async function authenticatePrincipalSponsor(req) {
    const auth = await authenticateMainnetIdentity(req)
    if (!auth.ok) return auth
    const policy = resolveMainnetDirectSponsorApprovalPolicy(env)
    if (!policy.configured) return {
      ok: false, status: 503, error: 'mainnet-direct-sponsor-approval-policy-not-configured',
      requiredEnvironment: policy.missing,
    }
    if (auth.session.address !== policy.sponsorAddress) return {
      ok: false, status: 403, error: 'wallet-is-not-the-configured-mainnet-asset-principal-sponsor',
    }
    return { ok: true, session: auth.session, policy }
  }

  async function authenticateFeeSponsor(req) {
    const auth = await authenticateMainnetIdentity(req)
    if (!auth.ok) return auth
    const feePolicy = resolveMainnetDirectFeeApprovalPolicy(env)
    if (!feePolicy.configured) return {
      ok: false, status: 503, error: 'mainnet-direct-fee-sponsor-policy-not-configured',
      requiredEnvironment: feePolicy.missing,
    }
    const assetPolicy = resolveMainnetDirectSponsorApprovalPolicy(env)
    if (!assetPolicy.configured) return {
      ok: false, status: 503, error: 'mainnet-direct-asset-sponsor-policy-not-configured',
      requiredEnvironment: assetPolicy.missing,
    }
    if (feePolicy.sponsorAddress === assetPolicy.sponsorAddress) return {
      ok: false, status: 409, error: 'fee-and-asset-sponsor-wallets-must-be-distinct',
    }
    if (auth.session.address !== feePolicy.sponsorAddress) return {
      ok: false, status: 403, error: 'wallet-is-not-the-configured-mainnet-fee-sponsor',
    }
    return { ok: true, session: auth.session, feePolicy, assetPolicy }
  }

  function validatePrincipalFunding(roleResult, request, policy, nowMs) {
    const blockers = []
    const checkedAt = Date.parse(roleResult?.checkedAt || '')
    if (roleResult?.success !== true || !Number.isFinite(checkedAt)
      || checkedAt > nowMs + 5_000 || nowMs - checkedAt > 15_000) blockers.push('fresh-mainnet-sponsor-role-snapshot-required')
    const roles = roleResult?.roles || {}
    const fee = roles.networkFeeSponsor || {}
    const principal = roles.assetPrincipalSponsor || {}
    if (principal.address !== policy.sponsorAddress || principal.onChainBalanceRead !== true
      || principal.tokenBalancesComplete !== true) blockers.push('configured-asset-principal-balance-not-independently-verified')
    const token = Array.isArray(principal.tokens) ? principal.tokens.find(item =>
      item?.asset === 'USDT' && item?.tokenContract === OFFICIAL_MAINNET_USDT_CONTRACT
      && item?.status === 'verified' && item?.decimals === 6
      && /^[1-9][0-9]*$/.test(String(item?.balanceBaseUnits || ''))) : null
    if (!token || BigInt(token.balanceBaseUnits) < BigInt(request.amountBaseUnits)) blockers.push('official-mainnet-usdt-sponsor-balance-does-not-cover-request')
    if (!isValidTronAddress(fee.address) || fee.address === policy.sponsorAddress
      || roleResult?.configuredAddressesDistinct !== true) blockers.push('distinct-mainnet-network-fee-sponsor-not-configured')
    if (fee.onChainBalanceRead !== true || fee.native?.status !== 'verified'
      || typeof fee.native?.balanceSun !== 'string' || !/^[1-9][0-9]*$/.test(fee.native.balanceSun)
      || fee.resourceStatus?.resourceRead !== true) blockers.push('mainnet-network-fee-sponsor-positive-trx-and-resources-not-verified')
    return { ready: blockers.length === 0, blockers }
  }

  function validateFeeFunding(roleResult, request, feePolicy, assetPolicy, nowMs) {
    const blockers = []
    const checkedAt = Date.parse(roleResult?.checkedAt || '')
    if (roleResult?.success !== true || !Number.isFinite(checkedAt)
      || checkedAt > nowMs + 5_000 || nowMs - checkedAt > 15_000) blockers.push('fresh-mainnet-sponsor-role-snapshot-required')
    const roles = roleResult?.roles || {}
    const fee = roles.networkFeeSponsor || {}
    const principal = roles.assetPrincipalSponsor || {}
    const feeBalanceValid = typeof fee.native?.balanceSun === 'string'
      && /^[1-9][0-9]*$/.test(fee.native.balanceSun)
    if (fee.address !== feePolicy.sponsorAddress || !isValidTronAddress(fee.address)
      || fee.onChainBalanceRead !== true || fee.native?.status !== 'verified'
      || !feeBalanceValid || fee.resourceStatus?.resourceRead !== true) {
      blockers.push('configured-fee-sponsor-positive-trx-and-resource-snapshot-not-verified')
    } else if (BigInt(fee.native.balanceSun) < BigInt(feePolicy.maxFeeSun)) {
      blockers.push('fee-sponsor-positive-trx-balance-below-approved-fee-cap')
    }
    if (principal.address !== assetPolicy.sponsorAddress || roleResult?.configuredAddressesDistinct !== true
      || !isValidTronAddress(principal.address)) blockers.push('distinct-configured-asset-principal-sponsor-not-verified')
    if (BigInt(request.amountBaseUnits) > BigInt(assetPolicy.maxUsdtBaseUnits)) {
      blockers.push('request-exceeds-current-asset-principal-sponsor-cap')
    }
    const token = Array.isArray(principal.tokens) ? principal.tokens.find(item =>
      item?.asset === 'USDT' && item?.tokenContract === OFFICIAL_MAINNET_USDT_CONTRACT
      && item?.status === 'verified' && item?.decimals === 6
      && /^[1-9][0-9]*$/.test(String(item?.balanceBaseUnits || ''))) : null
    if (principal.onChainBalanceRead !== true || principal.tokenBalancesComplete !== true
      || !token || BigInt(token.balanceBaseUnits) < BigInt(request.amountBaseUnits)) blockers.push('official-mainnet-usdt-principal-not-verified-for-exact-request')
    const delegation = roleResult?.feeSponsorDelegationToPrincipal || {}
    const types = new Set(Array.isArray(delegation.auditedResourceTypes) ? delegation.auditedResourceTypes : [])
    if (!(delegation.success === true && delegation.transactionAuditVerified === true
      && types.has('ENERGY') && types.has('BANDWIDTH')
      && typeof delegation.activeEnergyStakeSun === 'string' && /^[1-9][0-9]*$/.test(delegation.activeEnergyStakeSun)
      && typeof delegation.activeBandwidthStakeSun === 'string' && /^[1-9][0-9]*$/.test(delegation.activeBandwidthStakeSun))) {
      blockers.push('fee-sponsor-energy-and-bandwidth-delegation-audit-not-verified')
    }
    return { ready: blockers.length === 0, blockers }
  }

  function validateKey(req, res) {
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)) {
      res.status(400).json({ success: false, error: 'invalid-idempotency-key', canSubmitSponsoredTransfer: false })
      return null
    }
    return key
  }

  router.get('/sponsorship/mainnet-direct/requests/:idempotencyKey/approvals', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetIdentity(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = validateKey(req, res)
    if (!key) return
    try {
      const result = await store.findApprovalsForOwner(key, auth.session.address)
      if (!result?.success) return res.status(result?.reason === 'request-not-found' ? 404 : 503).json({ success: false, error: result?.reason || 'approval-status-unavailable' })
      const sponsorApproved = result.sponsorApproval?.status === 'approved-active'
      const feeSponsorApproved = result.feeSponsorApproval?.status === 'approved-active'
      return res.json({
        success: true, sponsorApproval: result.sponsorApproval,
        feeSponsorApproval: result.feeSponsorApproval,
        sponsorApproved, feeSponsorApproved,
        canSubmitSponsoredTransfer: false, transactionBroadcast: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'approval-status-unavailable' })
    }
  })

  router.get('/sponsorship/mainnet-direct/review-queue', async (req, res) => {
    noStore(res)
    const auth = await authenticatePrincipalSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error, ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const rawLimit = req.query?.limit === undefined ? '50' : String(req.query.limit)
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) return res.status(400).json({ success: false, error: 'invalid-limit' })
    try {
      const result = await store.listSponsorReviewQueue({ limit: Number(rawLimit) })
      if (result?.success !== true) return res.status(503).json({ success: false, error: result?.reason || 'sponsor-review-queue-unavailable', canSubmitSponsoredTransfer: false })
      return res.json({
        success: true, status: 'sponsor-review-queue-loaded',
        sponsorAddress: auth.policy.sponsorAddress, organizationReference: auth.policy.organizationReference,
        requests: result.requests, count: result.requests.length,
        sponsorApprovalEnabled: true, canCreateSigningIntent: false,
        canSubmitSponsoredTransfer: false, transactionBroadcast: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-review-queue-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.post('/sponsorship/mainnet-direct/requests/:idempotencyKey/approval-challenge', async (req, res) => {
    noStore(res)
    const auth = await authenticatePrincipalSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error, ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const key = validateKey(req, res)
    if (!key) return
    try {
      const found = await store.findRequestForSponsor(key)
      if (!found?.success || !found.request) return res.status(404).json({ success: false, error: 'sponsor-request-not-found' })
      const request = found.request
      if (request.status !== 'pending-sponsor-review' || request.network !== 'mainnet'
        || request.asset !== 'USDT' || request.tokenContract !== OFFICIAL_MAINNET_USDT_CONTRACT) {
        return res.status(409).json({ success: false, error: 'request-not-eligible-for-mainnet-sponsor-approval' })
      }
      if (BigInt(request.amountBaseUnits) > BigInt(auth.policy.maxUsdtBaseUnits)) {
        return res.status(409).json({ success: false, error: 'request-exceeds-sponsor-approval-cap' })
      }
      const funding = validatePrincipalFunding(await readSponsorRoles('mainnet', { refresh: true }), request, auth.policy, now())
      if (!funding.ready) return res.status(409).json({
        success: false, error: 'mainnet-sponsor-funding-preflight-blocked', blockers: funding.blockers,
        canCreateSigningIntent: false, canSubmitSponsoredTransfer: false,
      })
      const nonce = nonceFactory()
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return res.status(503).json({ success: false, error: 'approval-challenge-randomness-unavailable' })
      const issuedAtMs = now()
      const issuedAt = new Date(issuedAtMs).toISOString()
      const expiresAt = new Date(issuedAtMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS).toISOString()
      const message = buildMainnetDirectSponsorApprovalMessage({ request, policy: auth.policy, nonce, issuedAt, expiresAt })
      const challengeId = randomBytes(24).toString('hex')
      const stored = await store.createApprovalChallenge({
        idempotencyKey: key, sponsorAddress: auth.policy.sponsorAddress, origin: req.get('origin'),
        nonceHash: sha256Hex(nonce), messageSha256: sha256Hex(message),
        requestSnapshotSha256: mainnetDirectSponsorRequestSnapshotHash(request),
        challengeId, policy: auth.policy, issuedAt, expiresAt,
      })
      if (stored?.success !== true) return res.status(409).json({ success: false, error: stored?.reason || 'approval-challenge-not-created', canSubmitSponsoredTransfer: false })
      return res.status(201).json({
        success: true, status: 'sponsor-approval-signature-required', challengeId, nonce, message,
        request: stored.request, sponsorAddress: auth.policy.sponsorAddress,
        organizationReference: auth.policy.organizationReference, expiresAt,
        sponsorApprovalRecorded: false, signingIntentCreated: false, canSubmitSponsoredTransfer: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'approval-challenge-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.post('/sponsorship/mainnet-direct/requests/:idempotencyKey/approve', async (req, res) => {
    noStore(res)
    const auth = await authenticatePrincipalSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error, ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const key = validateKey(req, res)
    if (!key) return
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some(x => !['nonce', 'signature'].includes(x))
      || typeof body.nonce !== 'string' || !NONCE_PATTERN.test(body.nonce)
      || typeof body.signature !== 'string' || !SIGNATURE_PATTERN.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-approval-signature-payload', canSubmitSponsoredTransfer: false })
    }
    try {
      const consumed = await store.consumeApprovalChallenge({
        nonceHash: sha256Hex(body.nonce), sponsorAddress: auth.policy.sponsorAddress,
        origin: req.get('origin'), nowMs: now(),
      })
      if (consumed?.success !== true) return res.status(409).json({ success: false, error: consumed?.reason || 'approval-challenge-invalid-expired-or-replayed', canSubmitSponsoredTransfer: false })
      const challenge = consumed.challenge
      const request = consumed.request
      if (request.idempotencyKey !== key || challenge.sponsorAddress !== auth.policy.sponsorAddress
        || challenge.organizationReference !== auth.policy.organizationReference
        || challenge.agreementReference !== auth.policy.agreementReference
        || challenge.agreementSha256 !== auth.policy.agreementDocumentSha256
        || challenge.requestSnapshotSha256 !== mainnetDirectSponsorRequestSnapshotHash(request)) {
        return res.status(409).json({ success: false, error: 'approval-challenge-request-or-policy-mismatch', canSubmitSponsoredTransfer: false })
      }
      const message = buildMainnetDirectSponsorApprovalMessage({
        request, policy: auth.policy, nonce: body.nonce,
        issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      })
      const messageSha256 = sha256Hex(message)
      if (messageSha256 !== challenge.messageSha256) return res.status(409).json({ success: false, error: 'approval-message-digest-mismatch' })
      const verified = await verifyMainnetDirectSponsorApprovalSignature({
        message, signature: body.signature, expectedSponsorAddress: auth.policy.sponsorAddress,
        nowMs: now(), issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
        verifyMessage: verifySponsorMessage,
      })
      if (verified?.verified !== true) return res.status(401).json({
        success: false, error: verified?.reason || 'sponsor-approval-signature-invalid',
        challengeConsumed: true, canSubmitSponsoredTransfer: false,
      })
      const approvedAtMs = now()
      const expiresAt = new Date(approvedAtMs + 30 * 60 * 1000).toISOString()
      const recorded = await store.recordSponsorApproval({
        requestId: request.id, challengeId: challenge.challengeId,
        sponsorAddress: auth.policy.sponsorAddress,
        organizationReference: auth.policy.organizationReference,
        agreementReference: auth.policy.agreementReference,
        agreementSha256: auth.policy.agreementDocumentSha256, messageSha256,
        signature: body.signature, approvedAt: new Date(approvedAtMs).toISOString(), expiresAt,
      })
      if (recorded?.success !== true) return res.status(409).json({ success: false, error: recorded?.reason || 'sponsor-approval-not-recorded', canSubmitSponsoredTransfer: false })
      return res.json({
        success: true, status: 'sponsor-approved-principal-only', request,
        sponsorApproval: recorded.approval, sponsorApproved: true,
        feeSponsorApproval: false, feeSponsorApproved: false,
        budgetReserved: false, signingIntentCreated: false,
        canCreateSigningIntent: false, canSubmitSponsoredTransfer: false,
        transactionBroadcast: false, unpaidFallbackToUserFunds: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-approval-verification-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.get('/sponsorship/mainnet-direct/fee-review-queue', async (req, res) => {
    noStore(res)
    const auth = await authenticateFeeSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error, ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const rawLimit = req.query?.limit === undefined ? '50' : String(req.query.limit)
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) return res.status(400).json({ success: false, error: 'invalid-limit' })
    try {
      const result = await store.listFeeSponsorReviewQueue({ limit: Number(rawLimit) })
      if (result?.success !== true) return res.status(503).json({ success: false, error: result?.reason || 'fee-sponsor-review-queue-unavailable', canSubmitSponsoredTransfer: false })
      return res.json({
        success: true, status: 'fee-sponsor-review-queue-loaded',
        feeSponsorAddress: auth.feePolicy.sponsorAddress,
        organizationReference: auth.feePolicy.organizationReference,
        requests: result.requests, count: result.requests.length,
        feeSponsorApprovalEnabled: true, signingIntentCreated: false,
        canSubmitSponsoredTransfer: false, transactionBroadcast: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'fee-sponsor-review-queue-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.post('/sponsorship/mainnet-direct/requests/:idempotencyKey/fee-approval-challenge', async (req, res) => {
    noStore(res)
    const auth = await authenticateFeeSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error, ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const key = validateKey(req, res)
    if (!key) return
    try {
      const found = await store.findRequestForSponsor(key)
      if (!found?.success || !found.request) return res.status(404).json({ success: false, error: 'sponsor-request-not-found' })
      const request = found.request
      if (request.status !== 'pending-sponsor-review' || request.network !== 'mainnet'
        || request.asset !== 'USDT' || request.tokenContract !== OFFICIAL_MAINNET_USDT_CONTRACT) {
        return res.status(409).json({ success: false, error: 'request-not-eligible-for-fee-sponsor-approval' })
      }
      const funding = validateFeeFunding(await readSponsorRoles('mainnet', { refresh: true }), request, auth.feePolicy, auth.assetPolicy, now())
      if (!funding.ready) return res.status(409).json({
        success: false, error: 'mainnet-fee-sponsor-funding-preflight-blocked', blockers: funding.blockers,
        canSubmitSponsoredTransfer: false,
      })
      const nonce = nonceFactory()
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return res.status(503).json({ success: false, error: 'fee-approval-challenge-randomness-unavailable' })
      const issuedAtMs = now()
      const issuedAt = new Date(issuedAtMs).toISOString()
      const expiresAt = new Date(issuedAtMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS).toISOString()
      const message = buildMainnetDirectFeeSponsorApprovalMessage({
        request, feePolicy: auth.feePolicy, assetPolicy: auth.assetPolicy, nonce, issuedAt, expiresAt,
      })
      const challengeId = randomBytes(24).toString('hex')
      const stored = await store.createFeeApprovalChallenge({
        idempotencyKey: key, sponsorAddress: auth.feePolicy.sponsorAddress,
        origin: req.get('origin'), nonceHash: sha256Hex(nonce),
        messageSha256: sha256Hex(message), requestSnapshotSha256: mainnetDirectSponsorRequestSnapshotHash(request),
        challengeId, feePolicy: auth.feePolicy, issuedAt, expiresAt,
      })
      if (stored?.success !== true) return res.status(409).json({ success: false, error: stored?.reason || 'fee-approval-challenge-not-created', canSubmitSponsoredTransfer: false })
      return res.status(201).json({
        success: true, status: 'fee-sponsor-approval-signature-required',
        challengeId, nonce, message, request: stored.request,
        feeSponsorAddress: auth.feePolicy.sponsorAddress,
        organizationReference: auth.feePolicy.organizationReference,
        maxFeeSun: auth.feePolicy.maxFeeSun,
        principalApprovalId: stored.principalApprovalId,
        expiresAt, feeSponsorApprovalRecorded: false,
        resourceBudgetReserved: false, signingIntentCreated: false,
        canSubmitSponsoredTransfer: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'fee-approval-challenge-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.post('/sponsorship/mainnet-direct/requests/:idempotencyKey/approve-fees', async (req, res) => {
    noStore(res)
    const auth = await authenticateFeeSponsor(req)
    if (!auth.ok) return res.status(auth.status).json({
      success: false, error: auth.error, ...(auth.requiredEnvironment ? { requiredEnvironment: auth.requiredEnvironment } : {}),
      canSubmitSponsoredTransfer: false,
    })
    const key = validateKey(req, res)
    if (!key) return
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some(x => !['nonce', 'signature'].includes(x))
      || typeof body.nonce !== 'string' || !NONCE_PATTERN.test(body.nonce)
      || typeof body.signature !== 'string' || !SIGNATURE_PATTERN.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-fee-sponsor-approval-signature-payload', canSubmitSponsoredTransfer: false })
    }
    try {
      const consumed = await store.consumeFeeApprovalChallenge({
        nonceHash: sha256Hex(body.nonce), sponsorAddress: auth.feePolicy.sponsorAddress,
        origin: req.get('origin'), nowMs: now(),
      })
      if (consumed?.success !== true) return res.status(409).json({ success: false, error: consumed?.reason || 'fee-approval-challenge-invalid-expired-or-replayed', canSubmitSponsoredTransfer: false })
      const challenge = consumed.challenge
      const request = consumed.request
      if (request.idempotencyKey !== key || challenge.sponsorAddress !== auth.feePolicy.sponsorAddress
        || challenge.organizationReference !== auth.feePolicy.organizationReference
        || challenge.agreementReference !== auth.feePolicy.agreementReference
        || challenge.agreementSha256 !== auth.feePolicy.agreementDocumentSha256
        || challenge.maxFeeSun !== auth.feePolicy.maxFeeSun
        || challenge.requestSnapshotSha256 !== mainnetDirectSponsorRequestSnapshotHash(request)) {
        return res.status(409).json({ success: false, error: 'fee-approval-challenge-request-or-policy-mismatch', canSubmitSponsoredTransfer: false })
      }
      const message = buildMainnetDirectFeeSponsorApprovalMessage({
        request, feePolicy: auth.feePolicy, assetPolicy: auth.assetPolicy,
        nonce: body.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      })
      const messageSha256 = sha256Hex(message)
      if (messageSha256 !== challenge.messageSha256) return res.status(409).json({ success: false, error: 'fee-approval-message-digest-mismatch' })
      const verified = await verifyMainnetDirectSponsorApprovalSignature({
        message, signature: body.signature, expectedSponsorAddress: auth.feePolicy.sponsorAddress,
        nowMs: now(), issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
        verifyMessage: verifySponsorMessage,
      })
      if (verified?.verified !== true) return res.status(401).json({
        success: false, error: verified?.reason || 'fee-sponsor-approval-signature-invalid',
        challengeConsumed: true, canSubmitSponsoredTransfer: false,
      })
      const approvedAtMs = now()
      const expiresAt = new Date(approvedAtMs + 30 * 60 * 1000).toISOString()
      const recorded = await store.recordFeeSponsorApproval({
        requestId: request.id, principalApprovalId: challenge.principalApprovalId,
        challengeId: challenge.challengeId, sponsorAddress: auth.feePolicy.sponsorAddress,
        organizationReference: auth.feePolicy.organizationReference,
        agreementReference: auth.feePolicy.agreementReference,
        agreementSha256: auth.feePolicy.agreementDocumentSha256,
        messageSha256, signature: body.signature, maxFeeSun: auth.feePolicy.maxFeeSun,
        approvedAt: new Date(approvedAtMs).toISOString(), expiresAt,
      })
      if (recorded?.success !== true) return res.status(409).json({ success: false, error: recorded?.reason || 'fee-sponsor-approval-not-recorded', canSubmitSponsoredTransfer: false })
      return res.json({
        success: true, status: 'fee-sponsor-approved-network-fees-only',
        request, feeSponsorApproval: recorded.approval, sponsorApproved: true,
        feeSponsorApproved: true, budgetReserved: false, resourceBudgetReserved: false,
        signingIntentCreated: false, canCreateSigningIntent: false,
        canSubmitSponsoredTransfer: false, transactionBroadcast: false, unpaidFallbackToUserFunds: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'fee-sponsor-approval-verification-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  return router
}

export default createMainnetDirectSponsorApprovalRouter()
