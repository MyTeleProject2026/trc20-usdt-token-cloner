import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { Trx } from 'tronweb'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const ROLES = new Set(['asset-principal', 'network-fees'])
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/
let pool
let schemaPromise

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Origin, Authorization')
}

function configuredOrigins(env) {
  return [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN, env.TRON_TRANSFER_UI_ORIGIN]
    .flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim())
    .filter(Boolean)
}

function requestOrigin(req) {
  const origin = clean(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin && parsed.protocol === 'https:' ? origin : ''
  } catch {
    return ''
  }
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
  pool.on('error', (error) => console.error('Sponsor organization database error:', error?.code || 'unknown'))
  return pool
}

function normalizeRoles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ROLES.size) return null
  if (value.some((item) => typeof item !== 'string' || !ROLES.has(item))) return null
  if (new Set(value).size !== value.length) return null
  return [...value].sort()
}

function parseUsdt(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) {
    throw new Error('Invalid USDT amount')
  }
  const [whole, fraction = ''] = value.split('.')
  const baseUnits = BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6))
  if (baseUnits <= 0n || baseUnits > (1n << 256n) - 1n) throw new Error('Invalid USDT amount')
  return baseUnits.toString()
}

export function parseSponsorOrganizationUsdtAmount(value) {
  return parseUsdt(value)
}

function buildOrganizationApplicationMessage(input) {
  return [
    'TRON Transfer sponsor organization application',
    'Purpose: sign the organization details and declarations only. This is not a transaction or permission to spend.',
    'Version: sponsor-organization-application-v1',
    'Network: TRON Mainnet',
    'Sponsor wallet: ' + input.wallet,
    'Organization: ' + input.organizationName,
    'Business email: ' + input.businessEmail,
    'Jurisdiction: ' + input.jurisdiction,
    'Website: ' + (input.website || 'not provided'),
    'Requested roles: ' + input.roles.join(', '),
    'Declarations: authorized representative; controls the sponsor wallet; proposed funds are lawfully controlled; agrees to a separate written mandate defining any permitted provider-managed payout authorization; consents to application-data processing.',
  ].join('\n')
}

function buildMandateMessage(input) {
  return [
    'TRON Transfer sponsor payout mandate',
    'Purpose: confirm the exact limits and agreement reference below. This is not a transaction and does not itself move funds.',
    'Version: ' + (input.executionMode === 'fincra-automatic' ? 'sponsor-payout-mandate-v2' : 'sponsor-payout-mandate-v1'),
    'Network: TRON Mainnet',
    'Sponsor wallet: ' + input.wallet,
    'Organization application: ' + input.applicationId,
    'Agreement reference: ' + input.agreementReference,
    'Agreement SHA-256: ' + input.agreementDigest,
    'Purpose: ' + input.purpose,
    'Maximum per payout (USDT base units): ' + input.perPayoutBaseUnits,
    'Daily maximum (USDT base units): ' + input.dailyBaseUnits,
    'Valid from: ' + input.validFrom,
    'Valid until: ' + input.validUntil,
    ...(input.executionMode === 'fincra-automatic' ? [
      'Execution mode: fincra-automatic',
      'Provider: Fincra',
      'Fincra business ID: ' + input.providerBusinessId,
      'Standing authorization: the platform may submit Mainnet USDT TRC20 payouts from this identified and separately funded provider business account without a fresh sponsor wallet signature for each payout, only within the limits, purpose, validity and agreement above.',
      'This authorization does not permit use of any other business account, asset, network, beneficiary scope or funds outside the signed agreement. The sponsor may revoke this mandate.',
    ] : ['This mandate is subject to independent review and can be revoked. Every payout still requires the sponsor-authorized signing method.']),
  ].join('\n')
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_organization_applications (
          id UUID PRIMARY KEY,
          sponsor_wallet_address TEXT NOT NULL,
          organization_name TEXT NOT NULL,
          business_email TEXT NOT NULL,
          jurisdiction TEXT NOT NULL,
          website TEXT,
          requested_roles JSONB NOT NULL CHECK (jsonb_typeof(requested_roles) = 'array'),
          application_signature_hash CHAR(64) NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending-review'
            CHECK (status IN ('pending-review','in-review','accepted-for-due-diligence','declined','closed')),
          review_reference TEXT,
          reviewed_by_address TEXT,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (sponsor_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$')
        )
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS sponsor_organization_applications_wallet_idx
        ON ${SCHEMA}.sponsor_organization_applications (sponsor_wallet_address, created_at DESC)
      `)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sponsor_organization_one_open_application_idx
        ON ${SCHEMA}.sponsor_organization_applications (sponsor_wallet_address)
        WHERE status IN ('pending-review','in-review','accepted-for-due-diligence')
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_organization_mandates (
          id UUID PRIMARY KEY,
          application_id UUID NOT NULL REFERENCES ${SCHEMA}.sponsor_organization_applications(id),
          sponsor_wallet_address TEXT NOT NULL,
          agreement_reference TEXT NOT NULL,
          agreement_digest CHAR(64) NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('asset-principal','network-fees','both')),
          per_payout_limit_base_units NUMERIC(78,0) NOT NULL CHECK (per_payout_limit_base_units > 0),
          daily_limit_base_units NUMERIC(78,0) NOT NULL CHECK (daily_limit_base_units > 0),
          valid_from TIMESTAMPTZ NOT NULL,
          valid_until TIMESTAMPTZ NOT NULL,
          sponsor_signature_hash CHAR(64) NOT NULL,
          status TEXT NOT NULL DEFAULT 'signed-awaiting-review'
            CHECK (status IN ('signed-awaiting-review','verified','authorized','declined','revoked','expired')),
          review_reference TEXT,
          reviewed_by_address TEXT,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (daily_limit_base_units >= per_payout_limit_base_units),
          CHECK (valid_until > valid_from),
          CHECK (sponsor_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}
        ON ${SCHEMA}.sponsor_organization_mandates (sponsor_wallet_address, status, valid_until)
      `)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sponsor_organization_one_open_mandate_idx
        ON ${SCHEMA}.sponsor_organization_mandates (sponsor_wallet_address)
        WHERE status IN ('signed-awaiting-review','verified','authorized')
      `)
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

async function requireSession(req, env, getSession, now) {
  const origin = requestOrigin(req)
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!origin || !configuredOrigins(env).includes(origin) || !match) {
    return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
  }
  let lookup
  try {
    lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
  } catch {
    lookup = null
  }
  const session = lookup?.session
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'wallet-session-storage-unavailable' }
  if (!session || session.network !== 'mainnet' || session.origin !== origin
    || session.expiresAt <= now() || !isValidTronAddress(session.address)) {
    return { ok: false, status: 401, error: 'wallet-session-invalid-or-expired' }
  }
  return { ok: true, address: session.address }
}

async function requireOwner(req, env, getSession, now) {
  const auth = await requireSession(req, env, getSession, now)
  if (!auth.ok) return auth
  if (!isValidTronAddress(clean(env.OWNER_WALLET_ADDRESS, 64))
    || auth.address !== clean(env.OWNER_WALLET_ADDRESS, 64)) {
    return { ok: false, status: 403, error: 'platform-owner-only' }
  }
  return auth
}

function publicApplication(row) {
  return {
    id: row.id,
    sponsorWalletAddress: row.sponsor_wallet_address,
    organizationName: row.organization_name,
    businessEmail: row.business_email,
    jurisdiction: row.jurisdiction,
    website: row.website || null,
    requestedRoles: row.requested_roles,
    status: row.status,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function publicMandate(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    sponsorWalletAddress: row.sponsor_wallet_address,
    agreementReference: row.agreement_reference,
    agreementDigest: row.agreement_digest,
    purpose: row.purpose,
    executionMode: row.execution_mode || 'per-transfer',
    providerName: row.provider_name || null,
    providerBusinessId: row.provider_business_id || null,
    perPayoutLimitBaseUnits: String(row.per_payout_limit_base_units),
    dailyLimitBaseUnits: String(row.daily_limit_base_units),
    validFrom: new Date(row.valid_from).toISOString(),
    validUntil: new Date(row.valid_until).toISOString(),
    status: row.status,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function createSponsorOrganizationRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  now = () => Date.now(),
  verifyMessage = async (message, signature) => Trx.verifyMessageV2(message, signature),
} = {}) {
  const router = Router()

  router.get('/organizations/config', (_req, res) => {
    noStore(res)
    return res.json({
      success: true,
      network: 'mainnet',
      walletSignatureRequired: true,
      organizationReviewRequired: true,
      writtenMandateRequired: true,
      independentVerificationRequired: true,
      sponsorFundingRequired: true,
      payoutEnabledByApplication: false,
      supportedExecutionModes: ['per-transfer', 'fincra-automatic'],
      fincraAutomaticModeGateConfigured: env.FINCRA_AUTO_PAYOUTS_ENABLED === 'true',
      note: 'An organization application or signed mandate does not activate payouts. Independent review, verified funding, matching Fincra business configuration and all live-payout gates remain required.',
    })
  })

  router.post('/organizations/applications', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const configuredOwner = clean(env.OWNER_WALLET_ADDRESS, 64)
    if (configuredOwner && auth.address === configuredOwner) {
      return res.status(403).json({ success: false, error: 'platform-owner-wallet-cannot-act-as-third-party-sponsor' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['organizationName', 'businessEmail', 'jurisdiction', 'website', 'requestedRoles', 'applicationSignature']
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const organizationName = clean(body.organizationName, 120)
    const businessEmail = clean(body.businessEmail, 254).toLowerCase()
    const jurisdiction = clean(body.jurisdiction, 100)
    const websiteRaw = clean(body.website, 300)
    const roles = normalizeRoles(body.requestedRoles)
    let website = null
    if (websiteRaw) {
      try {
        const parsed = new URL(websiteRaw)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid URL')
        website = parsed.origin
      } catch {
        return res.status(400).json({ success: false, error: 'invalid-https-website' })
      }
    }
    if (organizationName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(businessEmail)
      || jurisdiction.length < 2 || !roles) {
      return res.status(400).json({ success: false, error: 'invalid-organization-profile' })
    }
    const message = buildOrganizationApplicationMessage({
      wallet: auth.address, organizationName, businessEmail, jurisdiction, website, roles,
    })
    let signer
    try { signer = await verifyMessage(message, body.applicationSignature) } catch { signer = null }
    if (signer !== auth.address) return res.status(401).json({ success: false, error: 'application-signature-address-mismatch' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const existing = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE sponsor_wallet_address=$1 AND status IN ('pending-review','in-review','accepted-for-due-diligence')
         ORDER BY created_at DESC LIMIT 1`,
        [auth.address],
      )
      if (existing.rows[0]) return res.status(409).json({ success: false, error: 'open-organization-application-exists', application: publicApplication(existing.rows[0]) })
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.sponsor_organization_applications
         (id,sponsor_wallet_address,organization_name,business_email,jurisdiction,website,requested_roles,application_signature_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
        [randomUUID(), auth.address, organizationName, businessEmail, jurisdiction, website,
          JSON.stringify(roles), digest(body.applicationSignature)],
      )
      return res.status(201).json({
        success: true,
        application: publicApplication(result.rows[0]),
        organizationVerified: false,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
        note: 'Application recorded. This does not verify organization identity or authorize spending.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-storage-failed' })
    }
  })

  router.get('/organizations/me', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const application = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE sponsor_wallet_address=$1 ORDER BY created_at DESC LIMIT 1`,
        [auth.address],
      )
      const row = application.rows[0] || null
      const mandates = row ? await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_mandates
         WHERE application_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [row.id],
      ) : { rows: [] }
      return res.json({
        success: true,
        application: row ? publicApplication(row) : null,
        mandates: mandates.rows.map(publicMandate),
        payoutAuthorized: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-read-failed' })
    }
  })

  router.get('/organizations/applications', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE status IN ('pending-review','in-review','accepted-for-due-diligence')
         ORDER BY created_at ASC LIMIT 50`,
      )
      return res.json({ success: true, applications: result.rows.map(publicApplication), payoutAuthorized: false })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-queue-failed' })
    }
  })

  router.post('/organizations/applications/:id/review', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'reviewReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    if (!['in-review', 'accepted-for-due-diligence', 'declined', 'closed'].includes(body.decision)) {
      return res.status(400).json({ success: false, error: 'invalid-organization-review-decision' })
    }
    const reviewReference = clean(body.reviewReference, 160)
    if (body.decision !== 'in-review' && reviewReference.length < 8) {
      return res.status(400).json({ success: false, error: 'review-reference-required' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_applications
         SET status=$2, review_reference=$3, reviewed_by_address=$4, reviewed_at=now(), updated_at=now()
         WHERE id=$1 AND status IN ('pending-review','in-review','accepted-for-due-diligence')
         RETURNING *`,
        [id, body.decision, reviewReference || null, auth.address],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'application-not-reviewable' })
      return res.json({
        success: true,
        application: publicApplication(result.rows[0]),
        organizationVerified: false,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
        note: 'Review state recorded only. Independent legal and funding verification remain separate.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-review-failed' })
    }
  })

  router.post('/organizations/applications/:id/mandates', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['agreementReference', 'agreementDigest', 'purpose', 'executionMode', 'providerName', 'providerBusinessId', 'perPayoutLimit', 'dailyLimit', 'validFrom', 'validUntil', 'mandateSignature']
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const agreementReference = clean(body.agreementReference, 160)
    const agreementDigest = clean(body.agreementDigest, 64).toLowerCase()
    const purpose = body.purpose
    const executionMode = body.executionMode === undefined ? 'per-transfer' : body.executionMode
    const providerName = executionMode === 'fincra-automatic' ? clean(body.providerName, 24).toLowerCase() : null
    const providerBusinessId = executionMode === 'fincra-automatic' ? clean(body.providerBusinessId, 128) : null
    if (agreementReference.length < 8 || !SHA256_RE.test(agreementDigest)
      || !['asset-principal', 'network-fees', 'both'].includes(purpose)
      || !['per-transfer', 'fincra-automatic'].includes(executionMode)
      || (executionMode === 'fincra-automatic' && (providerName !== 'fincra'
        || !/^[A-Za-z0-9._:-]{4,128}$/.test(providerBusinessId)))) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-mandate' })
    }
    let perPayoutBaseUnits, dailyBaseUnits
    try {
      perPayoutBaseUnits = parseUsdt(body.perPayoutLimit)
      dailyBaseUnits = parseUsdt(body.dailyLimit)
    } catch {
      return res.status(400).json({ success: false, error: 'invalid-mandate-limits' })
    }
    if (BigInt(dailyBaseUnits) < BigInt(perPayoutBaseUnits)) {
      return res.status(400).json({ success: false, error: 'daily-limit-below-per-payout-limit' })
    }
    const validFrom = new Date(body.validFrom)
    const validUntil = new Date(body.validUntil)
    const nowMs = now()
    if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validUntil.getTime())
      || validFrom.getTime() < nowMs - 60000 || validUntil.getTime() <= nowMs
      || validUntil.getTime() <= validFrom.getTime()
      || validUntil.getTime() > nowMs + 366 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, error: 'invalid-mandate-validity' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const application = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications WHERE id=$1 LIMIT 1`,
        [id],
      )
      const row = application.rows[0]
      if (!row || row.sponsor_wallet_address !== auth.address
        || row.status !== 'accepted-for-due-diligence') {
        return res.status(403).json({ success: false, error: 'accepted-organization-application-required' })
      }
      const requestedRoles = Array.isArray(row.requested_roles) ? row.requested_roles : []
      if (purpose === 'asset-principal' && !requestedRoles.includes('asset-principal')
        || purpose === 'network-fees' && !requestedRoles.includes('network-fees')
        || purpose === 'both' && (!requestedRoles.includes('asset-principal') || !requestedRoles.includes('network-fees'))
        || executionMode === 'fincra-automatic' && (!requestedRoles.includes('asset-principal') || !['asset-principal', 'both'].includes(purpose))) {
        return res.status(403).json({ success: false, error: 'mandate-purpose-not-requested-by-organization' })
      }
      const message = buildMandateMessage({
        wallet: auth.address,
        applicationId: id,
        agreementReference,
        agreementDigest,
        purpose,
        perPayoutBaseUnits,
        dailyBaseUnits,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
        executionMode,
        providerBusinessId,
      })
      let signer
      try { signer = await verifyMessage(message, body.mandateSignature) } catch { signer = null }
      if (signer !== auth.address) return res.status(401).json({ success: false, error: 'mandate-signature-address-mismatch' })
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.sponsor_organization_mandates
         (id,application_id,sponsor_wallet_address,agreement_reference,agreement_digest,purpose,
          per_payout_limit_base_units,daily_limit_base_units,valid_from,valid_until,sponsor_signature_hash,
          execution_mode,provider_name,provider_business_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [randomUUID(), id, auth.address, agreementReference, agreementDigest, purpose,
          perPayoutBaseUnits, dailyBaseUnits, validFrom.toISOString(), validUntil.toISOString(),
          digest(body.mandateSignature), executionMode, providerName, providerBusinessId],
      )
      return res.status(201).json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        independentVerificationRequired: true,
        payoutAuthorized: false,
        executionMode,
        note: executionMode === 'fincra-automatic'
          ? 'The sponsor signed a standing Fincra authorization limited to the exact business ID, Mainnet USDT TRC20 purpose, agreement digest, caps and validity. Independent organization/provider verification and funded-balance checks are still required; the mode is not active yet.'
          : 'The sponsor signed the mandate terms. A signed mandate digest is not independent proof that the agreement, organization or funding is valid.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-storage-failed' })
    }
  })

  router.get('/organizations/mandates', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT m.*, a.organization_name FROM ${SCHEMA}.sponsor_organization_mandates m
         JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id
         WHERE m.status IN ('signed-awaiting-review','verified') ORDER BY m.created_at ASC LIMIT 50`,
      )
      return res.json({ success: true, mandates: result.rows.map(publicMandate), payoutAuthorized: false })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-queue-failed' })
    }
  })

  router.post('/organizations/mandates/:id/review', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'verificationReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    if (!['verify', 'authorize', 'decline'].includes(body.decision)) {
      return res.status(400).json({ success: false, error: 'invalid-mandate-review-decision' })
    }
    const reference = clean(body.verificationReference, 160)
    if (reference.length < 8) return res.status(400).json({ success: false, error: 'independent-verification-reference-required' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    const priorStatuses = body.decision === 'verify'
      ? ['signed-awaiting-review']
      : body.decision === 'authorize'
        ? ['verified']
        : ['signed-awaiting-review', 'verified']
    const nextStatus = body.decision === 'verify' ? 'verified'
      : body.decision === 'authorize' ? 'authorized' : 'declined'
    try {
      await ensureSchema(db)
      if (body.decision === 'authorize') {
        const mandateEvidence = await db.query(
          `SELECT execution_mode, provider_name, provider_business_id
           FROM ${SCHEMA}.sponsor_organization_mandates WHERE id=$1 FOR UPDATE`,
          [id],
        )
        const pendingMandate = mandateEvidence.rows[0]
        if (!pendingMandate) return res.status(404).json({ success: false, error: 'sponsor-mandate-not-found' })
        if (pendingMandate.execution_mode === 'fincra-automatic'
          && (pendingMandate.provider_name !== 'fincra'
            || !clean(env.FINCRA_BUSINESS_ID, 128)
            || pendingMandate.provider_business_id !== clean(env.FINCRA_BUSINESS_ID, 128))) {
          return res.status(409).json({
            success: false, error: 'fincra-business-id-does-not-match-server-configuration',
            payoutAuthorized: false,
            note: 'Before authorizing this standing mandate, configure the exact Fincra business ID server-side and independently verify that the signed agreement and sponsor authority cover that same business account.',
          })
        }
      }
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_mandates
         SET status=$2, review_reference=$3, reviewed_by_address=$4, reviewed_at=now(), updated_at=now()
         WHERE id=$1 AND status=ANY($5::text[]) RETURNING *`,
        [id, nextStatus, reference, auth.address, priorStatuses],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'mandate-not-reviewable-or-wrong-state' })
      const authorized = body.decision === 'authorize'
      return res.json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        payoutAuthorized: authorized,
        note: authorized
          ? result.rows[0].execution_mode === 'fincra-automatic'
            ? 'Standing Fincra authorization recorded against the independently reviewed business-account and agreement evidence. Automatic submission remains separately disabled until the backend live-payout gates, requester allowlist, exact business ID and funded USDT balance all pass.'
            : 'Internal sponsor mandate authorization recorded against the evidence reference. Payout preparation still checks the sponsor’s live Mainnet USDT balance, resources, limits, validity and sponsor signature.'
          : body.decision === 'verify'
            ? 'Agreement review recorded. A separate owner authorization decision is still required before this mandate can be used by the payout workflow.'
            : 'Mandate declined. No payout was activated.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-review-failed' })
    }
  })

  router.post('/organizations/mandates/:id/revoke', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_mandates
         SET status='revoked', updated_at=now()
         WHERE id=$1 AND sponsor_wallet_address=$2
           AND status IN ('signed-awaiting-review','verified','authorized')
         RETURNING *`,
        [id, auth.address],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'mandate-not-revocable-or-not-owned' })
      return res.json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        payoutAuthorized: false,
        note: 'The sponsor revoked this mandate. New payout preparation and broadcast checks will reject it.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-revocation-failed' })
    }
  })

  return router
}

export default createSponsorOrganizationRouter()
)
        )
      `)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_mandates
        ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'per-transfer',
        ADD COLUMN IF NOT EXISTS provider_name TEXT,
        ADD COLUMN IF NOT EXISTS provider_business_id TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_mandates
        DROP CONSTRAINT IF EXISTS sponsor_organization_mandates_execution_mode_check`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_mandates
        ADD CONSTRAINT sponsor_organization_mandates_execution_mode_check
        CHECK (execution_mode IN ('per-transfer','fincra-automatic'))`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_mandates
        DROP CONSTRAINT IF EXISTS sponsor_organization_mandates_provider_scope_check`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_mandates
        ADD CONSTRAINT sponsor_organization_mandates_provider_scope_check
        CHECK ((execution_mode='per-transfer' AND provider_name IS NULL AND provider_business_id IS NULL)
          OR (execution_mode='fincra-automatic' AND provider_name='fincra'
            AND provider_business_id ~ '^[A-Za-z0-9._:-]{4,128}
        ON ${SCHEMA}.sponsor_organization_mandates (sponsor_wallet_address, status, valid_until)
      `)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sponsor_organization_one_open_mandate_idx
        ON ${SCHEMA}.sponsor_organization_mandates (sponsor_wallet_address)
        WHERE status IN ('signed-awaiting-review','verified','authorized')
      `)
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

async function requireSession(req, env, getSession, now) {
  const origin = requestOrigin(req)
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!origin || !configuredOrigins(env).includes(origin) || !match) {
    return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
  }
  let lookup
  try {
    lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
  } catch {
    lookup = null
  }
  const session = lookup?.session
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'wallet-session-storage-unavailable' }
  if (!session || session.network !== 'mainnet' || session.origin !== origin
    || session.expiresAt <= now() || !isValidTronAddress(session.address)) {
    return { ok: false, status: 401, error: 'wallet-session-invalid-or-expired' }
  }
  return { ok: true, address: session.address }
}

async function requireOwner(req, env, getSession, now) {
  const auth = await requireSession(req, env, getSession, now)
  if (!auth.ok) return auth
  if (!isValidTronAddress(clean(env.OWNER_WALLET_ADDRESS, 64))
    || auth.address !== clean(env.OWNER_WALLET_ADDRESS, 64)) {
    return { ok: false, status: 403, error: 'platform-owner-only' }
  }
  return auth
}

function publicApplication(row) {
  return {
    id: row.id,
    sponsorWalletAddress: row.sponsor_wallet_address,
    organizationName: row.organization_name,
    businessEmail: row.business_email,
    jurisdiction: row.jurisdiction,
    website: row.website || null,
    requestedRoles: row.requested_roles,
    status: row.status,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function publicMandate(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    sponsorWalletAddress: row.sponsor_wallet_address,
    agreementReference: row.agreement_reference,
    agreementDigest: row.agreement_digest,
    purpose: row.purpose,
    perPayoutLimitBaseUnits: String(row.per_payout_limit_base_units),
    dailyLimitBaseUnits: String(row.daily_limit_base_units),
    validFrom: new Date(row.valid_from).toISOString(),
    validUntil: new Date(row.valid_until).toISOString(),
    status: row.status,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function createSponsorOrganizationRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  now = () => Date.now(),
  verifyMessage = async (message, signature) => Trx.verifyMessageV2(message, signature),
} = {}) {
  const router = Router()

  router.get('/organizations/config', (_req, res) => {
    noStore(res)
    return res.json({
      success: true,
      network: 'mainnet',
      walletSignatureRequired: true,
      organizationReviewRequired: true,
      writtenMandateRequired: true,
      independentVerificationRequired: true,
      sponsorFundingRequired: true,
      payoutEnabledByApplication: false,
      note: 'An organization application or signed mandate does not activate payouts. Independent review, verified funding and an authorized sponsor signer remain required.',
    })
  })

  router.post('/organizations/applications', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const configuredOwner = clean(env.OWNER_WALLET_ADDRESS, 64)
    if (configuredOwner && auth.address === configuredOwner) {
      return res.status(403).json({ success: false, error: 'platform-owner-wallet-cannot-act-as-third-party-sponsor' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['organizationName', 'businessEmail', 'jurisdiction', 'website', 'requestedRoles', 'applicationSignature']
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const organizationName = clean(body.organizationName, 120)
    const businessEmail = clean(body.businessEmail, 254).toLowerCase()
    const jurisdiction = clean(body.jurisdiction, 100)
    const websiteRaw = clean(body.website, 300)
    const roles = normalizeRoles(body.requestedRoles)
    let website = null
    if (websiteRaw) {
      try {
        const parsed = new URL(websiteRaw)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid URL')
        website = parsed.origin
      } catch {
        return res.status(400).json({ success: false, error: 'invalid-https-website' })
      }
    }
    if (organizationName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(businessEmail)
      || jurisdiction.length < 2 || !roles) {
      return res.status(400).json({ success: false, error: 'invalid-organization-profile' })
    }
    const message = buildOrganizationApplicationMessage({
      wallet: auth.address, organizationName, businessEmail, jurisdiction, website, roles,
    })
    let signer
    try { signer = await verifyMessage(message, body.applicationSignature) } catch { signer = null }
    if (signer !== auth.address) return res.status(401).json({ success: false, error: 'application-signature-address-mismatch' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const existing = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE sponsor_wallet_address=$1 AND status IN ('pending-review','in-review','accepted-for-due-diligence')
         ORDER BY created_at DESC LIMIT 1`,
        [auth.address],
      )
      if (existing.rows[0]) return res.status(409).json({ success: false, error: 'open-organization-application-exists', application: publicApplication(existing.rows[0]) })
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.sponsor_organization_applications
         (id,sponsor_wallet_address,organization_name,business_email,jurisdiction,website,requested_roles,application_signature_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
        [randomUUID(), auth.address, organizationName, businessEmail, jurisdiction, website,
          JSON.stringify(roles), digest(body.applicationSignature)],
      )
      return res.status(201).json({
        success: true,
        application: publicApplication(result.rows[0]),
        organizationVerified: false,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
        note: 'Application recorded. This does not verify organization identity or authorize spending.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-storage-failed' })
    }
  })

  router.get('/organizations/me', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const application = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE sponsor_wallet_address=$1 ORDER BY created_at DESC LIMIT 1`,
        [auth.address],
      )
      const row = application.rows[0] || null
      const mandates = row ? await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_mandates
         WHERE application_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [row.id],
      ) : { rows: [] }
      return res.json({
        success: true,
        application: row ? publicApplication(row) : null,
        mandates: mandates.rows.map(publicMandate),
        payoutAuthorized: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-read-failed' })
    }
  })

  router.get('/organizations/applications', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE status IN ('pending-review','in-review','accepted-for-due-diligence')
         ORDER BY created_at ASC LIMIT 50`,
      )
      return res.json({ success: true, applications: result.rows.map(publicApplication), payoutAuthorized: false })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-queue-failed' })
    }
  })

  router.post('/organizations/applications/:id/review', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'reviewReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    if (!['in-review', 'accepted-for-due-diligence', 'declined', 'closed'].includes(body.decision)) {
      return res.status(400).json({ success: false, error: 'invalid-organization-review-decision' })
    }
    const reviewReference = clean(body.reviewReference, 160)
    if (body.decision !== 'in-review' && reviewReference.length < 8) {
      return res.status(400).json({ success: false, error: 'review-reference-required' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_applications
         SET status=$2, review_reference=$3, reviewed_by_address=$4, reviewed_at=now(), updated_at=now()
         WHERE id=$1 AND status IN ('pending-review','in-review','accepted-for-due-diligence')
         RETURNING *`,
        [id, body.decision, reviewReference || null, auth.address],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'application-not-reviewable' })
      return res.json({
        success: true,
        application: publicApplication(result.rows[0]),
        organizationVerified: false,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
        note: 'Review state recorded only. Independent legal and funding verification remain separate.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-review-failed' })
    }
  })

  router.post('/organizations/applications/:id/mandates', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['agreementReference', 'agreementDigest', 'purpose', 'perPayoutLimit', 'dailyLimit', 'validFrom', 'validUntil', 'mandateSignature']
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const agreementReference = clean(body.agreementReference, 160)
    const agreementDigest = clean(body.agreementDigest, 64).toLowerCase()
    const purpose = body.purpose
    if (agreementReference.length < 8 || !SHA256_RE.test(agreementDigest)
      || !['asset-principal', 'network-fees', 'both'].includes(purpose)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-mandate' })
    }
    let perPayoutBaseUnits, dailyBaseUnits
    try {
      perPayoutBaseUnits = parseUsdt(body.perPayoutLimit)
      dailyBaseUnits = parseUsdt(body.dailyLimit)
    } catch {
      return res.status(400).json({ success: false, error: 'invalid-mandate-limits' })
    }
    if (BigInt(dailyBaseUnits) < BigInt(perPayoutBaseUnits)) {
      return res.status(400).json({ success: false, error: 'daily-limit-below-per-payout-limit' })
    }
    const validFrom = new Date(body.validFrom)
    const validUntil = new Date(body.validUntil)
    const nowMs = now()
    if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validUntil.getTime())
      || validFrom.getTime() < nowMs - 60000 || validUntil.getTime() <= nowMs
      || validUntil.getTime() <= validFrom.getTime()
      || validUntil.getTime() > nowMs + 366 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, error: 'invalid-mandate-validity' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const application = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications WHERE id=$1 LIMIT 1`,
        [id],
      )
      const row = application.rows[0]
      if (!row || row.sponsor_wallet_address !== auth.address
        || row.status !== 'accepted-for-due-diligence') {
        return res.status(403).json({ success: false, error: 'accepted-organization-application-required' })
      }
      const requestedRoles = Array.isArray(row.requested_roles) ? row.requested_roles : []
      if (purpose === 'asset-principal' && !requestedRoles.includes('asset-principal')
        || purpose === 'network-fees' && !requestedRoles.includes('network-fees')
        || purpose === 'both' && (!requestedRoles.includes('asset-principal') || !requestedRoles.includes('network-fees'))) {
        return res.status(403).json({ success: false, error: 'mandate-purpose-not-requested-by-organization' })
      }
      const message = buildMandateMessage({
        wallet: auth.address,
        applicationId: id,
        agreementReference,
        agreementDigest,
        purpose,
        perPayoutBaseUnits,
        dailyBaseUnits,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
      })
      let signer
      try { signer = await verifyMessage(message, body.mandateSignature) } catch { signer = null }
      if (signer !== auth.address) return res.status(401).json({ success: false, error: 'mandate-signature-address-mismatch' })
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.sponsor_organization_mandates
         (id,application_id,sponsor_wallet_address,agreement_reference,agreement_digest,purpose,
          per_payout_limit_base_units,daily_limit_base_units,valid_from,valid_until,sponsor_signature_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [randomUUID(), id, auth.address, agreementReference, agreementDigest, purpose,
          perPayoutBaseUnits, dailyBaseUnits, validFrom.toISOString(), validUntil.toISOString(),
          digest(body.mandateSignature)],
      )
      return res.status(201).json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        independentVerificationRequired: true,
        payoutAuthorized: false,
        note: 'The sponsor signed the mandate terms. A signed mandate digest is not independent proof that the agreement, organization or funding is valid.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-storage-failed' })
    }
  })

  router.get('/organizations/mandates', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT m.*, a.organization_name FROM ${SCHEMA}.sponsor_organization_mandates m
         JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id
         WHERE m.status IN ('signed-awaiting-review','verified') ORDER BY m.created_at ASC LIMIT 50`,
      )
      return res.json({ success: true, mandates: result.rows.map(publicMandate), payoutAuthorized: false })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-queue-failed' })
    }
  })

  router.post('/organizations/mandates/:id/review', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'verificationReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    if (!['verify', 'authorize', 'decline'].includes(body.decision)) {
      return res.status(400).json({ success: false, error: 'invalid-mandate-review-decision' })
    }
    const reference = clean(body.verificationReference, 160)
    if (reference.length < 8) return res.status(400).json({ success: false, error: 'independent-verification-reference-required' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    const priorStatuses = body.decision === 'verify'
      ? ['signed-awaiting-review']
      : body.decision === 'authorize'
        ? ['verified']
        : ['signed-awaiting-review', 'verified']
    const nextStatus = body.decision === 'verify' ? 'verified'
      : body.decision === 'authorize' ? 'authorized' : 'declined'
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_mandates
         SET status=$2, review_reference=$3, reviewed_by_address=$4, reviewed_at=now(), updated_at=now()
         WHERE id=$1 AND status=ANY($5::text[]) RETURNING *`,
        [id, nextStatus, reference, auth.address, priorStatuses],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'mandate-not-reviewable-or-wrong-state' })
      const authorized = body.decision === 'authorize'
      return res.json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        payoutAuthorized: authorized,
        note: authorized
          ? 'Internal sponsor mandate authorization recorded against the evidence reference. Payout preparation still checks the sponsor’s live Mainnet USDT balance, resources, limits, validity and sponsor signature.'
          : body.decision === 'verify'
            ? 'Agreement review recorded. A separate owner authorization decision is still required before this mandate can be used by the payout workflow.'
            : 'Mandate declined. No payout was activated.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-review-failed' })
    }
  })

  router.post('/organizations/mandates/:id/revoke', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_mandates
         SET status='revoked', updated_at=now()
         WHERE id=$1 AND sponsor_wallet_address=$2
           AND status IN ('signed-awaiting-review','verified','authorized')
         RETURNING *`,
        [id, auth.address],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'mandate-not-revocable-or-not-owned' })
      return res.json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        payoutAuthorized: false,
        note: 'The sponsor revoked this mandate. New payout preparation and broadcast checks will reject it.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-revocation-failed' })
    }
  })

  return router
}

export default createSponsorOrganizationRouter()
))`)
      await db.query(`CREATE INDEX IF NOT EXISTS sponsor_organization_mandates_fincra_auto_idx
        ON ${SCHEMA}.sponsor_organization_mandates (provider_name, provider_business_id, status, valid_until)
        WHERE execution_mode='fincra-automatic'`)
      await db.query(`
        CREATE INDEX IF NOT EXISTS sponsor_organization_mandates_wallet_status_idx
        ON ${SCHEMA}.sponsor_organization_mandates (sponsor_wallet_address, status, valid_until)
      `)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sponsor_organization_one_open_mandate_idx
        ON ${SCHEMA}.sponsor_organization_mandates (sponsor_wallet_address)
        WHERE status IN ('signed-awaiting-review','verified','authorized')
      `)
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

async function requireSession(req, env, getSession, now) {
  const origin = requestOrigin(req)
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!origin || !configuredOrigins(env).includes(origin) || !match) {
    return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
  }
  let lookup
  try {
    lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
  } catch {
    lookup = null
  }
  const session = lookup?.session
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'wallet-session-storage-unavailable' }
  if (!session || session.network !== 'mainnet' || session.origin !== origin
    || session.expiresAt <= now() || !isValidTronAddress(session.address)) {
    return { ok: false, status: 401, error: 'wallet-session-invalid-or-expired' }
  }
  return { ok: true, address: session.address }
}

async function requireOwner(req, env, getSession, now) {
  const auth = await requireSession(req, env, getSession, now)
  if (!auth.ok) return auth
  if (!isValidTronAddress(clean(env.OWNER_WALLET_ADDRESS, 64))
    || auth.address !== clean(env.OWNER_WALLET_ADDRESS, 64)) {
    return { ok: false, status: 403, error: 'platform-owner-only' }
  }
  return auth
}

function publicApplication(row) {
  return {
    id: row.id,
    sponsorWalletAddress: row.sponsor_wallet_address,
    organizationName: row.organization_name,
    businessEmail: row.business_email,
    jurisdiction: row.jurisdiction,
    website: row.website || null,
    requestedRoles: row.requested_roles,
    status: row.status,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function publicMandate(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    sponsorWalletAddress: row.sponsor_wallet_address,
    agreementReference: row.agreement_reference,
    agreementDigest: row.agreement_digest,
    purpose: row.purpose,
    perPayoutLimitBaseUnits: String(row.per_payout_limit_base_units),
    dailyLimitBaseUnits: String(row.daily_limit_base_units),
    validFrom: new Date(row.valid_from).toISOString(),
    validUntil: new Date(row.valid_until).toISOString(),
    status: row.status,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function createSponsorOrganizationRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  now = () => Date.now(),
  verifyMessage = async (message, signature) => Trx.verifyMessageV2(message, signature),
} = {}) {
  const router = Router()

  router.get('/organizations/config', (_req, res) => {
    noStore(res)
    return res.json({
      success: true,
      network: 'mainnet',
      walletSignatureRequired: true,
      organizationReviewRequired: true,
      writtenMandateRequired: true,
      independentVerificationRequired: true,
      sponsorFundingRequired: true,
      payoutEnabledByApplication: false,
      note: 'An organization application or signed mandate does not activate payouts. Independent review, verified funding and an authorized sponsor signer remain required.',
    })
  })

  router.post('/organizations/applications', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const configuredOwner = clean(env.OWNER_WALLET_ADDRESS, 64)
    if (configuredOwner && auth.address === configuredOwner) {
      return res.status(403).json({ success: false, error: 'platform-owner-wallet-cannot-act-as-third-party-sponsor' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['organizationName', 'businessEmail', 'jurisdiction', 'website', 'requestedRoles', 'applicationSignature']
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const organizationName = clean(body.organizationName, 120)
    const businessEmail = clean(body.businessEmail, 254).toLowerCase()
    const jurisdiction = clean(body.jurisdiction, 100)
    const websiteRaw = clean(body.website, 300)
    const roles = normalizeRoles(body.requestedRoles)
    let website = null
    if (websiteRaw) {
      try {
        const parsed = new URL(websiteRaw)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid URL')
        website = parsed.origin
      } catch {
        return res.status(400).json({ success: false, error: 'invalid-https-website' })
      }
    }
    if (organizationName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(businessEmail)
      || jurisdiction.length < 2 || !roles) {
      return res.status(400).json({ success: false, error: 'invalid-organization-profile' })
    }
    const message = buildOrganizationApplicationMessage({
      wallet: auth.address, organizationName, businessEmail, jurisdiction, website, roles,
    })
    let signer
    try { signer = await verifyMessage(message, body.applicationSignature) } catch { signer = null }
    if (signer !== auth.address) return res.status(401).json({ success: false, error: 'application-signature-address-mismatch' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const existing = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE sponsor_wallet_address=$1 AND status IN ('pending-review','in-review','accepted-for-due-diligence')
         ORDER BY created_at DESC LIMIT 1`,
        [auth.address],
      )
      if (existing.rows[0]) return res.status(409).json({ success: false, error: 'open-organization-application-exists', application: publicApplication(existing.rows[0]) })
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.sponsor_organization_applications
         (id,sponsor_wallet_address,organization_name,business_email,jurisdiction,website,requested_roles,application_signature_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
        [randomUUID(), auth.address, organizationName, businessEmail, jurisdiction, website,
          JSON.stringify(roles), digest(body.applicationSignature)],
      )
      return res.status(201).json({
        success: true,
        application: publicApplication(result.rows[0]),
        organizationVerified: false,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
        note: 'Application recorded. This does not verify organization identity or authorize spending.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-storage-failed' })
    }
  })

  router.get('/organizations/me', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const application = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE sponsor_wallet_address=$1 ORDER BY created_at DESC LIMIT 1`,
        [auth.address],
      )
      const row = application.rows[0] || null
      const mandates = row ? await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_mandates
         WHERE application_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [row.id],
      ) : { rows: [] }
      return res.json({
        success: true,
        application: row ? publicApplication(row) : null,
        mandates: mandates.rows.map(publicMandate),
        payoutAuthorized: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-read-failed' })
    }
  })

  router.get('/organizations/applications', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications
         WHERE status IN ('pending-review','in-review','accepted-for-due-diligence')
         ORDER BY created_at ASC LIMIT 50`,
      )
      return res.json({ success: true, applications: result.rows.map(publicApplication), payoutAuthorized: false })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-application-queue-failed' })
    }
  })

  router.post('/organizations/applications/:id/review', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'reviewReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    if (!['in-review', 'accepted-for-due-diligence', 'declined', 'closed'].includes(body.decision)) {
      return res.status(400).json({ success: false, error: 'invalid-organization-review-decision' })
    }
    const reviewReference = clean(body.reviewReference, 160)
    if (body.decision !== 'in-review' && reviewReference.length < 8) {
      return res.status(400).json({ success: false, error: 'review-reference-required' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_applications
         SET status=$2, review_reference=$3, reviewed_by_address=$4, reviewed_at=now(), updated_at=now()
         WHERE id=$1 AND status IN ('pending-review','in-review','accepted-for-due-diligence')
         RETURNING *`,
        [id, body.decision, reviewReference || null, auth.address],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'application-not-reviewable' })
      return res.json({
        success: true,
        application: publicApplication(result.rows[0]),
        organizationVerified: false,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
        note: 'Review state recorded only. Independent legal and funding verification remain separate.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'organization-review-failed' })
    }
  })

  router.post('/organizations/applications/:id/mandates', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['agreementReference', 'agreementDigest', 'purpose', 'perPayoutLimit', 'dailyLimit', 'validFrom', 'validUntil', 'mandateSignature']
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const agreementReference = clean(body.agreementReference, 160)
    const agreementDigest = clean(body.agreementDigest, 64).toLowerCase()
    const purpose = body.purpose
    if (agreementReference.length < 8 || !SHA256_RE.test(agreementDigest)
      || !['asset-principal', 'network-fees', 'both'].includes(purpose)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-mandate' })
    }
    let perPayoutBaseUnits, dailyBaseUnits
    try {
      perPayoutBaseUnits = parseUsdt(body.perPayoutLimit)
      dailyBaseUnits = parseUsdt(body.dailyLimit)
    } catch {
      return res.status(400).json({ success: false, error: 'invalid-mandate-limits' })
    }
    if (BigInt(dailyBaseUnits) < BigInt(perPayoutBaseUnits)) {
      return res.status(400).json({ success: false, error: 'daily-limit-below-per-payout-limit' })
    }
    const validFrom = new Date(body.validFrom)
    const validUntil = new Date(body.validUntil)
    const nowMs = now()
    if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validUntil.getTime())
      || validFrom.getTime() < nowMs - 60000 || validUntil.getTime() <= nowMs
      || validUntil.getTime() <= validFrom.getTime()
      || validUntil.getTime() > nowMs + 366 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, error: 'invalid-mandate-validity' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const application = await db.query(
        `SELECT * FROM ${SCHEMA}.sponsor_organization_applications WHERE id=$1 LIMIT 1`,
        [id],
      )
      const row = application.rows[0]
      if (!row || row.sponsor_wallet_address !== auth.address
        || row.status !== 'accepted-for-due-diligence') {
        return res.status(403).json({ success: false, error: 'accepted-organization-application-required' })
      }
      const requestedRoles = Array.isArray(row.requested_roles) ? row.requested_roles : []
      if (purpose === 'asset-principal' && !requestedRoles.includes('asset-principal')
        || purpose === 'network-fees' && !requestedRoles.includes('network-fees')
        || purpose === 'both' && (!requestedRoles.includes('asset-principal') || !requestedRoles.includes('network-fees'))) {
        return res.status(403).json({ success: false, error: 'mandate-purpose-not-requested-by-organization' })
      }
      const message = buildMandateMessage({
        wallet: auth.address,
        applicationId: id,
        agreementReference,
        agreementDigest,
        purpose,
        perPayoutBaseUnits,
        dailyBaseUnits,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
      })
      let signer
      try { signer = await verifyMessage(message, body.mandateSignature) } catch { signer = null }
      if (signer !== auth.address) return res.status(401).json({ success: false, error: 'mandate-signature-address-mismatch' })
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.sponsor_organization_mandates
         (id,application_id,sponsor_wallet_address,agreement_reference,agreement_digest,purpose,
          per_payout_limit_base_units,daily_limit_base_units,valid_from,valid_until,sponsor_signature_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [randomUUID(), id, auth.address, agreementReference, agreementDigest, purpose,
          perPayoutBaseUnits, dailyBaseUnits, validFrom.toISOString(), validUntil.toISOString(),
          digest(body.mandateSignature)],
      )
      return res.status(201).json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        independentVerificationRequired: true,
        payoutAuthorized: false,
        note: 'The sponsor signed the mandate terms. A signed mandate digest is not independent proof that the agreement, organization or funding is valid.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-storage-failed' })
    }
  })

  router.get('/organizations/mandates', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT m.*, a.organization_name FROM ${SCHEMA}.sponsor_organization_mandates m
         JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id
         WHERE m.status IN ('signed-awaiting-review','verified') ORDER BY m.created_at ASC LIMIT 50`,
      )
      return res.json({ success: true, mandates: result.rows.map(publicMandate), payoutAuthorized: false })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-queue-failed' })
    }
  })

  router.post('/organizations/mandates/:id/review', async (req, res) => {
    noStore(res)
    const auth = await requireOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'verificationReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    if (!['verify', 'authorize', 'decline'].includes(body.decision)) {
      return res.status(400).json({ success: false, error: 'invalid-mandate-review-decision' })
    }
    const reference = clean(body.verificationReference, 160)
    if (reference.length < 8) return res.status(400).json({ success: false, error: 'independent-verification-reference-required' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    const priorStatuses = body.decision === 'verify'
      ? ['signed-awaiting-review']
      : body.decision === 'authorize'
        ? ['verified']
        : ['signed-awaiting-review', 'verified']
    const nextStatus = body.decision === 'verify' ? 'verified'
      : body.decision === 'authorize' ? 'authorized' : 'declined'
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_mandates
         SET status=$2, review_reference=$3, reviewed_by_address=$4, reviewed_at=now(), updated_at=now()
         WHERE id=$1 AND status=ANY($5::text[]) RETURNING *`,
        [id, nextStatus, reference, auth.address, priorStatuses],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'mandate-not-reviewable-or-wrong-state' })
      const authorized = body.decision === 'authorize'
      return res.json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        payoutAuthorized: authorized,
        note: authorized
          ? 'Internal sponsor mandate authorization recorded against the evidence reference. Payout preparation still checks the sponsor’s live Mainnet USDT balance, resources, limits, validity and sponsor signature.'
          : body.decision === 'verify'
            ? 'Agreement review recorded. A separate owner authorization decision is still required before this mandate can be used by the payout workflow.'
            : 'Mandate declined. No payout was activated.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-review-failed' })
    }
  })

  router.post('/organizations/mandates/:id/revoke', async (req, res) => {
    noStore(res)
    const auth = await requireSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `UPDATE ${SCHEMA}.sponsor_organization_mandates
         SET status='revoked', updated_at=now()
         WHERE id=$1 AND sponsor_wallet_address=$2
           AND status IN ('signed-awaiting-review','verified','authorized')
         RETURNING *`,
        [id, auth.address],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'mandate-not-revocable-or-not-owned' })
      return res.json({
        success: true,
        mandate: publicMandate(result.rows[0]),
        payoutAuthorized: false,
        note: 'The sponsor revoked this mandate. New payout preparation and broadcast checks will reject it.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-mandate-revocation-failed' })
    }
  })

  return router
}

export default createSponsorOrganizationRouter()
