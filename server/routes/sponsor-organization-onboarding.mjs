import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import { Trx } from 'tronweb'
import pg from 'pg'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
const NETWORK = 'mainnet'
const ATTESTATION_VERSION = 'sponsor-organization-onboarding-2026-11-04-v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REVIEW_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/
const ROLES = new Set(['asset-principal', 'network-fees'])
const OPEN_STATUSES = ['pending-review', 'in-review', 'accepted-for-due-diligence']
const STATUSES = new Set(['pending-review', 'in-review', 'accepted-for-due-diligence', 'declined', 'closed'])

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization, Origin')
}

function bearer(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')
  const origin = req.get('origin') || ''
  return match && origin ? { tokenHash: digest(match[1]), origin } : null
}

function validName(value, min = 2, max = 120) {
  return typeof value === 'string'
    && value.trim().length >= min
    && value.trim().length <= max
    && !/[\r\n\x00-\x1f]/.test(value)
}

function normalizeWebsite(value) {
  if (value == null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string' || value.length > 300) return { ok: false }
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return { ok: false }
    return { ok: true, value: parsed.origin }
  } catch {
    return { ok: false }
  }
}

function normalizeRoles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ROLES.size) return null
  if (value.some((item) => typeof item !== 'string' || !ROLES.has(item))) return null
  if (new Set(value).size !== value.length) return null
  return [...value].sort()
}

function buildSponsorApplicationMessage({
  address, organizationName, businessEmail, jurisdiction, website, requestedRoles,
}) {
  return [
    'TRON Token Studio sponsor organization application authorization',
    'Purpose: confirm the exact organization details and declarations below. This is not a transaction, transfer, or spending authorization.',
    `Attestation version: ${ATTESTATION_VERSION}`,
    'Network: TRON Mainnet',
    `Sponsor wallet: ${address}`,
    `Organization: ${organizationName}`,
    `Business contact email: ${businessEmail}`,
    `Jurisdiction: ${jurisdiction}`,
    `Website: ${website || 'not provided'}`,
    `Requested roles: ${requestedRoles.join(', ')}`,
    'Declarations:',
    '1. I am authorized to represent this organization.',
    '2. The authenticated wallet is controlled by the organization or an authorized signer.',
    '3. The proposed funds are lawfully controlled and may be used for the stated sponsorship purpose.',
    '4. I accept separate written sponsor terms, caps, and transaction approvals before funding or payouts.',
    '5. I consent to storing these organization details for manual due diligence.',
  ].join('\n')
}

function rolesMatch(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && [...left].sort().join('|') === [...right].sort().join('|')
}

function toPublicApplication(row) {
  if (!row) return null
  return {
    id: String(row.id),
    sponsorReference: row.sponsor_reference,
    organizationName: row.organization_name,
    businessEmail: row.business_email,
    jurisdiction: row.jurisdiction,
    website: row.website || null,
    sponsorWalletAddress: row.sponsor_wallet_address,
    network: row.network,
    requestedRoles: Array.isArray(row.requested_roles) ? row.requested_roles : [],
    status: row.status,
    attestationVersion: row.attestation_version,
    attestations: {
      authorityToRepresentOrganization: row.authority_to_represent === true,
      controlsSponsorWallet: row.controls_sponsor_wallet === true,
      lawfulSourceOfFunds: row.lawful_source_of_funds === true,
      acceptsSponsorTerms: row.accepts_sponsor_terms === true,
      privacyConsent: row.privacy_consent === true,
    },
    reviewReference: row.review_reference || null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function transitionAllowed(from, to) {
  const transitions = {
    'pending-review': new Set(['in-review', 'accepted-for-due-diligence', 'declined']),
    'in-review': new Set(['accepted-for-due-diligence', 'declined']),
    'accepted-for-due-diligence': new Set(['in-review', 'declined', 'closed']),
    declined: new Set(['closed']),
    closed: new Set(),
  }
  return transitions[from]?.has(to) === true
}

/**
 * PostgreSQL store for wallet-bound sponsor organization applications.
 * It stores public organization metadata and attestations only; no keys,
 * signatures, recovery phrases, API credentials, or transaction payloads.
 */
export function createSponsorOrganizationStore(env = process.env) {
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
    pool.on('error', (error) => console.error('Sponsor organization database error:', error?.code || 'unknown'))
    return pool
  }

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organizations (
            id UUID PRIMARY KEY,
            sponsor_reference TEXT NOT NULL UNIQUE,
            organization_name TEXT NOT NULL,
            business_email TEXT NOT NULL,
            jurisdiction TEXT NOT NULL,
            website TEXT,
            sponsor_wallet_address TEXT NOT NULL,
            network TEXT NOT NULL CHECK (network = 'mainnet'),
            requested_roles JSONB NOT NULL CHECK (jsonb_typeof(requested_roles) = 'array'),
            attestation_version TEXT NOT NULL,
            application_signature_hash TEXT NOT NULL UNIQUE,
            authority_to_represent BOOLEAN NOT NULL CHECK (authority_to_represent),
            controls_sponsor_wallet BOOLEAN NOT NULL CHECK (controls_sponsor_wallet),
            lawful_source_of_funds BOOLEAN NOT NULL CHECK (lawful_source_of_funds),
            accepts_sponsor_terms BOOLEAN NOT NULL CHECK (accepts_sponsor_terms),
            privacy_consent BOOLEAN NOT NULL CHECK (privacy_consent),
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
          CREATE INDEX IF NOT EXISTS sponsor_organizations_status_created_idx
          ON trc20_token_clone.sponsor_organizations (status, created_at ASC)
        `)
        await db.query(`
        await db.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS sponsor_organizations_open_wallet_idx
          ON trc20_token_clone.sponsor_organizations (network, sponsor_wallet_address)
          WHERE status IN ('pending-review','in-review','accepted-for-due-diligence')
        `)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  async function create(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`sponsor-organization:${input.network}:${input.sponsorWalletAddress}`],
      )
      const existing = await client.query(`
        SELECT * FROM trc20_token_clone.sponsor_organizations
        WHERE network = $1 AND sponsor_wallet_address = $2
          AND status = ANY($3::text[])
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE
      `, [input.network, input.sponsorWalletAddress, OPEN_STATUSES])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const same = row.organization_name === input.organizationName
          && row.business_email === input.businessEmail
          && row.jurisdiction === input.jurisdiction
          && (row.website || null) === input.website
          && rolesMatch(row.requested_roles, input.requestedRoles)
        await client.query('COMMIT')
        return same
          ? { success: true, duplicate: true, application: toPublicApplication(row) }
          : { success: false, reason: 'open-application-already-exists' }
      }

      const recent = await client.query(`
        SELECT COUNT(*)::integer AS total
        FROM trc20_token_clone.sponsor_organizations
        WHERE sponsor_wallet_address = $1
          AND created_at >= now() - interval '24 hours'
      `, [input.sponsorWalletAddress])
      if (Number(recent.rows[0]?.total || 0) >= 3) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'application-rate-limited' }
      }

      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.sponsor_organizations (
          id, sponsor_reference, organization_name, business_email, jurisdiction,
          website, sponsor_wallet_address, network, requested_roles, attestation_version,
          authority_to_represent, controls_sponsor_wallet, lawful_source_of_funds,
          accepts_sponsor_terms, privacy_consent, application_signature_hash
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, TRUE, TRUE, TRUE, TRUE, TRUE, $11
        ) RETURNING *
      `, [
        input.id, input.sponsorReference, input.organizationName, input.businessEmail,
        input.jurisdiction, input.website, input.sponsorWalletAddress, input.network,
        JSON.stringify(input.requestedRoles), input.attestationVersion, input.applicationSignatureHash,
      ])
      await client.query(`
        INSERT INTO trc20_token_clone.audit_events (event_type, entity_type, entity_reference, details)
        VALUES ('sponsor-organization-application-created', 'sponsor-organization', $1, $2::jsonb)
      `, [
        input.id,
        JSON.stringify({
          sponsorReference: input.sponsorReference,
          sponsorWalletAddress: input.sponsorWalletAddress,
          network: input.network,
          requestedRoles: input.requestedRoles,
          status: 'pending-review',
          attestationVersion: input.attestationVersion,
          applicationSignatureHash: input.applicationSignatureHash,
          walletApplicationSignatureVerified: true,
        }),
      ])
      await client.query('COMMIT')
      return { success: true, duplicate: false, application: toPublicApplication(inserted.rows[0]) }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error?.code === '23505' && /application_signature_hash/.test(String(error.constraint || ''))) return { success: false, reason: 'application-signature-already-used' }
      if (error?.code === '23505') return { success: false, reason: 'open-application-already-exists' }
      console.error('Sponsor organization application write failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  }

  async function getByWallet({ network, sponsorWalletAddress }) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.sponsor_organizations
      WHERE network = $1 AND sponsor_wallet_address = $2
      ORDER BY created_at DESC LIMIT 1
    `, [network, sponsorWalletAddress])
    return result.rows[0]
      ? { success: true, application: toPublicApplication(result.rows[0]) }
      : { success: false, reason: 'application-not-found' }
  }

  async function list({ status = null, limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured', applications: [] }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.sponsor_organizations
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at ASC LIMIT $2
    `, [status, limit])
    return { success: true, applications: result.rows.map(toPublicApplication) }
  }

  async function review({ id, status, reviewReference, reviewedByAddress }) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(`
        SELECT id, status, review_reference
        FROM trc20_token_clone.sponsor_organizations
        WHERE id = $1::uuid FOR UPDATE
      `, [id])
      if (!current.rows[0]) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'application-not-found' }
      }
      const row = current.rows[0]
      if (row.status === status && row.review_reference === reviewReference) {
        await client.query('COMMIT')
        return { success: true, duplicate: true, id, status: row.status }
      }
      if (!transitionAllowed(row.status, status)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'invalid-status-transition' }
      }
      const updated = await client.query(`
        UPDATE trc20_token_clone.sponsor_organizations
        SET status = $2, review_reference = $3, reviewed_by_address = $4,
            reviewed_at = now(), updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, status, review_reference, reviewed_at, updated_at
      `, [id, status, reviewReference, reviewedByAddress])
      await client.query(`
        INSERT INTO trc20_token_clone.audit_events (event_type, entity_type, entity_reference, details)
        VALUES ('sponsor-organization-application-reviewed', 'sponsor-organization', $1, $2::jsonb)
      `, [
        id,
        JSON.stringify({
          status,
          reviewReference,
          reviewedByAddress,
          dueDiligenceAccepted: status === 'accepted-for-due-diligence',
          sponsorAgreementAuthorized: false,
          payoutAuthorized: false,
        }),
      ])
      await client.query('COMMIT')
      const result = updated.rows[0]
      return {
        success: true,
        duplicate: false,
        id: result.id,
        status: result.status,
        reviewReference: result.review_reference,
        reviewedAt: new Date(result.reviewed_at).toISOString(),
        updatedAt: new Date(result.updated_at).toISOString(),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Sponsor organization review failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  }

  async function close() {
    if (!pool) return
    const current = pool
    pool = null
    schemaPromise = null
    await current.end()
  }

  return { create, getByWallet, list, review, close }
}

export function createSponsorOrganizationOnboardingRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  store = createSponsorOrganizationStore(env),
  now = () => Date.now(),
  verifyMessage = async (message, signature) => Trx.verifyMessageV2(message, signature),
} = {}) {
  const router = Router()

  async function authenticateMainnetWallet(req) {
    const identity = bearer(req)
    if (!identity) return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
    let lookup
    try {
      lookup = await sessionLookup({ ...identity, nowMs: now() })
    } catch {
      lookup = null
    }
    if (lookup?.success !== true) return { ok: false, status: 503, error: 'wallet-session-storage-unavailable' }
    const session = lookup.session
    if (!session || session.network !== NETWORK || session.origin !== identity.origin
      || !ADDRESS_PATTERN.test(session.address || '') || !isValidTronAddress(session.address)) {
      return { ok: false, status: 403, error: 'valid-mainnet-wallet-session-required' }
    }
    return { ok: true, address: session.address }
  }

  async function authenticateOwner(req) {
    const wallet = await authenticateMainnetWallet(req)
    if (!wallet.ok) return wallet
    const configuredOwners = [
      env.OWNER_WALLET_ADDRESS,
      env.TREASURY_OWNER_ADDRESS,
    ].filter((value) => typeof value === 'string' && isValidTronAddress(value.trim()))
      .map((value) => value.trim())
    if (configuredOwners.length === 0) {
      return { ok: false, status: 503, error: 'owner-wallet-not-configured' }
    }
    if (!configuredOwners.includes(wallet.address)) {
      return { ok: false, status: 403, error: 'owner-wallet-not-authorized' }
    }
    return wallet
  }

  router.post('/tron/sponsorship/organizations', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetWallet(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error, sponsorAgreementAuthorized: false, payoutAuthorized: false })

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = new Set([
      'organizationName', 'businessEmail', 'jurisdiction', 'website', 'requestedRoles',
      'authorityToRepresentOrganization', 'controlsSponsorWallet', 'lawfulSourceOfFunds',
      'acceptsSponsorTerms', 'privacyConsent', 'applicationSignature',
    ])
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields', message: 'Only organization details, requested sponsorship roles and the listed attestations are accepted. Wallet secrets and signing material are never accepted.' })
    }

    const organizationName = typeof body.organizationName === 'string' ? body.organizationName.trim() : ''
    const businessEmail = typeof body.businessEmail === 'string' ? body.businessEmail.trim().toLowerCase() : ''
    const jurisdiction = typeof body.jurisdiction === 'string' ? body.jurisdiction.trim() : ''
    const website = normalizeWebsite(body.website)
    const requestedRoles = normalizeRoles(body.requestedRoles)
    if (!validName(organizationName) || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(businessEmail) || businessEmail.length > 254
      || !validName(jurisdiction, 2, 100) || !website.ok || !requestedRoles) {
      return res.status(400).json({ success: false, error: 'invalid-organization-application' })
    }
    const attestationFields = [
      'authorityToRepresentOrganization', 'controlsSponsorWallet',
      'lawfulSourceOfFunds', 'acceptsSponsorTerms', 'privacyConsent',
    ]
    if (attestationFields.some((field) => body[field] !== true)) {
      return res.status(400).json({
        success: false,
        error: 'required-attestation-missing',
        message: 'All five explicit attestations must be accepted. An attestation is a declaration for manual review, not independent legal verification.',
      })
    }

    const applicationSignature = typeof body.applicationSignature === 'string' ? body.applicationSignature : ''
    if (!/^0x[0-9a-f]{130}$/i.test(applicationSignature)) {
      return res.status(400).json({ success: false, error: 'application-wallet-signature-required', message: 'Sign the exact organization details and declarations in TronLink to submit this application.' })
    }
    const applicationMessage = buildSponsorApplicationMessage({
      address: auth.address,
      organizationName,
      businessEmail,
      jurisdiction,
      website: website.value,
      requestedRoles,
    })
    let recoveredApplicationSigner
    try {
      recoveredApplicationSigner = await verifyMessage(applicationMessage, applicationSignature)
    } catch {
      recoveredApplicationSigner = null
    }
    if (recoveredApplicationSigner !== auth.address) {
      return res.status(401).json({ success: false, error: 'application-signature-address-mismatch', message: 'The application message signature did not match the authenticated sponsor wallet.' })
    }

    const applicationSignatureHash = digest(applicationSignature)
    const id = randomUUID()
    const sponsorReference = `org-${id.replaceAll('-', '')}`
    try {
      const result = await store.create({
        id,
        sponsorReference,
        organizationName,
        businessEmail,
        jurisdiction,
        website: website.value,
        sponsorWalletAddress: auth.address,
        network: NETWORK,
        requestedRoles,
        attestationVersion: ATTESTATION_VERSION,
        applicationSignatureHash,
      })
      if (result?.success !== true || !result.application) {
        const reason = result?.reason || 'application-storage-unavailable'
        const status = ['open-application-already-exists', 'application-signature-already-used'].includes(reason) ? 409
          : reason === 'application-rate-limited' ? 429 : 503
        return res.status(status).json({
          success: false,
          error: reason,
          sponsorAgreementAuthorized: false,
          canContributeLiquidity: false,
          payoutAuthorized: false,
        })
      }
      return res.status(result.duplicate ? 200 : 201).json({
        success: true,
        duplicate: result.duplicate === true,
        status: result.application.status,
        application: result.application,
        walletControlProof: 'authenticated-mainnet-wallet-session',
        walletApplicationSignatureVerified: true,
        applicationSignatureStoredAsHashOnly: true,
        organizationAuthorizationIndependentlyVerified: false,
        sponsorAgreementAuthorized: false,
        canContributeLiquidity: false,
        payoutAuthorized: false,
        submissionEnabled: false,
        message: 'The organization and wallet application is stored for manual due diligence. This is not independent proof of legal-entity status, sponsor mandate, available funds, signer authorization, or permission to pay.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'application-storage-unavailable', sponsorAgreementAuthorized: false, payoutAuthorized: false })
    }
  })

  router.get('/tron/sponsorship/organizations/me', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetWallet(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    try {
      const result = await store.getByWallet({ network: NETWORK, sponsorWalletAddress: auth.address })
      if (result?.success !== true) {
        const status = result?.reason === 'application-not-found' ? 404 : 503
        return res.status(status).json({ success: false, error: result?.reason || 'application-lookup-unavailable' })
      }
      return res.json({
        success: true,
        application: result.application,
        organizationAuthorizationIndependentlyVerified: false,
        sponsorAgreementAuthorized: false,
        canContributeLiquidity: false,
        payoutAuthorized: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'application-lookup-unavailable' })
    }
  })

  router.get('/treasury/owner/sponsor-organizations', async (req, res) => {
    noStore(res)
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const statusFilter = req.query?.status === undefined ? null : req.query.status
    const limitText = req.query?.limit === undefined ? '50' : String(req.query.limit)
    const limit = Number(limitText)
    if ((statusFilter !== null && (typeof statusFilter !== 'string' || !STATUSES.has(statusFilter)))
      || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText) || !Number.isInteger(limit)) {
      return res.status(400).json({ success: false, error: 'invalid-query' })
    }
    try {
      const result = await store.list({ status: statusFilter, limit })
      if (result?.success !== true) return res.status(503).json({ success: false, error: result?.reason || 'application-list-unavailable' })
      return res.json({
        success: true,
        count: result.applications.length,
        applications: result.applications,
        dueDiligenceOnly: true,
        sponsorAgreementAuthorized: false,
        payoutAuthorized: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'application-list-unavailable' })
    }
  })

  router.post('/treasury/owner/sponsor-organizations/:id/review', async (req, res) => {
    noStore(res)
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = req.params?.id || ''
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (!UUID_PATTERN.test(id) || Object.keys(body).some((key) => !['status', 'reviewReference'].includes(key))) {
      return res.status(400).json({ success: false, error: 'invalid-review-request' })
    }
    const status = body.status
    const reviewReference = body.reviewReference == null ? null : body.reviewReference
    if (!['in-review', 'accepted-for-due-diligence', 'declined', 'closed'].includes(status)
      || (reviewReference !== null && (typeof reviewReference !== 'string' || !REVIEW_REFERENCE_PATTERN.test(reviewReference)))
      || (['accepted-for-due-diligence', 'declined'].includes(status) && !reviewReference)) {
      return res.status(400).json({ success: false, error: 'invalid-review-request', message: 'Due-diligence acceptance and decline decisions require a bounded internal review reference.' })
    }
    try {
      const result = await store.review({
        id,
        status,
        reviewReference,
        reviewedByAddress: auth.address,
      })
      if (result?.success !== true) {
        const code = result?.reason === 'application-not-found' ? 404
          : result?.reason === 'invalid-status-transition' ? 409 : 503
        return res.status(code).json({ success: false, error: result?.reason || 'application-review-failed' })
      }
      return res.json({
        success: true,
        application: result,
        dueDiligenceOnly: true,
        sponsorAgreementAuthorized: false,
        canContributeLiquidity: false,
        payoutAuthorized: false,
        submissionEnabled: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'application-review-failed' })
    }
  })

  return router
}

export default createSponsorOrganizationOnboardingRouter
