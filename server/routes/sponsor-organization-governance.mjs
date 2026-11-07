import { createHash, randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import pg from 'pg'
import { Trx } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { computeSponsorOrganizationEvidenceSetDigest } from '../sponsor-organization-governance.mjs'
import { getDocumentCustodyV2Config, scanAndStoreEvidenceV2 } from '../sponsor-document-custody-v2.mjs'
import { verifyMalwareScanAttestation, verifyPrivateVaultReceiptV2 } from '../sponsor-vault-receipt-v2.mjs'
import { getSponsorVaultReceiptKeyRegistry, getSponsorScannerAttestationKeyRegistry } from '../sponsor-vault-trust-registry.mjs'
import { getSponsorReviewerRegistry, getSponsorSecurityOfficerRegistry } from '../sponsor-governance-registry.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA_RE = /^[a-f0-9]{64}$/i
const ROLES = new Set(['compliance-reviewer', 'security-reviewer'])
const REVOCATION_REASONS = new Set(['sponsor-request', 'suspected-compromise', 'authority-withdrawn', 'provider-account-changed', 'evidence-invalidated', 'policy-breach', 'legal-or-compliance-hold', 'other'])
let pool
let schemaPromise

function clean(value, max = 256) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function hash(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex') }
function noStore(res) { res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Vary', 'Origin, Authorization') }
function configuredOrigins(env) {
  return [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN, env.TRON_TRANSFER_UI_ORIGIN]
    .flatMap((v) => typeof v === 'string' ? v.split(',') : []).map((v) => v.trim()).filter(Boolean)
}
function getDb(env) {
  if (pool) return pool
  if (!clean(env.DATABASE_URL, 4096)) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, max: 3, ssl: databaseSslConfig(connectionString, env) })
  pool.on('error', (error) => console.error('Sponsor governance database error:', error?.code || 'unknown'))
  return pool
}
async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
      await db.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_organization_evidence_artifacts (
        id UUID PRIMARY KEY,
        application_id UUID NOT NULL REFERENCES ${SCHEMA}.sponsor_organization_applications(id),
        mandate_id UUID NOT NULL REFERENCES ${SCHEMA}.sponsor_organization_mandates(id),
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('legal-entity-registration','beneficial-ownership','authorized-representative','sponsor-wallet-control','provider-account-ownership','provider-signer-policy','signed-agreement','source-of-funds','funding-balance','other')),
        storage_provider TEXT NOT NULL CHECK (storage_provider='approved-private-document-vault'),
        object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512 AND object_key !~ '(^/|[.][.]|^https?://)'),
        content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-fA-F0-9]{64}$'),
        media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf','image/jpeg','image/png')),
        byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
        encrypted_at_rest BOOLEAN NOT NULL CHECK (encrypted_at_rest=TRUE),
        malware_scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (malware_scan_status IN ('pending','clean')),
        vault_version_id TEXT,
        malware_scanner_version TEXT,
        vault_receipt_id TEXT,
        vault_receipt_key_id TEXT,
        vault_receipt_json JSONB,
        retention_mode TEXT,
        retention_until TIMESTAMPTZ,
        encryption_mode TEXT,
        uploaded_by_wallet TEXT NOT NULL CHECK (uploaded_by_wallet ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
        retention_policy_reference TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS malware_scan_status TEXT NOT NULL DEFAULT 'pending'`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS vault_version_id TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS malware_scanner_version TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS vault_receipt_id TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS vault_receipt_key_id TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS vault_receipt_json JSONB`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS retention_mode TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD COLUMN IF NOT EXISTS encryption_mode TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts DROP CONSTRAINT IF EXISTS sponsor_organization_evidence_artifacts_malware_scan_status_check`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts DROP CONSTRAINT IF EXISTS sponsor_org_evidence_scan_status_check`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ADD CONSTRAINT sponsor_org_evidence_scan_status_check CHECK (malware_scan_status IN ('pending','clean'))`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_evidence_artifacts ALTER COLUMN malware_scan_status SET DEFAULT 'pending'`)
      await db.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_organization_malware_scan_attestations (
        id UUID PRIMARY KEY,
        evidence_id UUID NOT NULL UNIQUE REFERENCES ${SCHEMA}.sponsor_organization_evidence_artifacts(id),
        content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-fA-F0-9]{64}$'),
        scanner_service TEXT NOT NULL CHECK (scanner_service='independent-signed-attestation'),
        scanner_version TEXT NOT NULL,
        attestation_key_id TEXT,
        attestation_json JSONB,
        scan_status TEXT NOT NULL CHECK (scan_status='clean'),
        scanned_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_malware_scan_attestations ADD COLUMN IF NOT EXISTS attestation_key_id TEXT`)
      await db.query(`ALTER TABLE ${SCHEMA}.sponsor_organization_malware_scan_attestations ADD COLUMN IF NOT EXISTS attestation_json JSONB`)
      await db.query(`CREATE INDEX IF NOT EXISTS sponsor_org_evidence_mandate_idx ON ${SCHEMA}.sponsor_organization_evidence_artifacts(mandate_id, created_at DESC)`)
      await db.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_organization_reviewer_decisions (
        id UUID PRIMARY KEY,
        application_id UUID NOT NULL REFERENCES ${SCHEMA}.sponsor_organization_applications(id),
        mandate_id UUID NOT NULL REFERENCES ${SCHEMA}.sponsor_organization_mandates(id),
        reviewer_wallet_address TEXT NOT NULL CHECK (reviewer_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
        reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('compliance-reviewer','security-reviewer')),
        evidence_set_digest CHAR(64) NOT NULL CHECK (evidence_set_digest ~ '^[a-fA-F0-9]{64}$'),
        decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','needs-more-evidence')),
        independence_attested BOOLEAN NOT NULL CHECK (independence_attested=TRUE),
        conflict_check_passed BOOLEAN NOT NULL CHECK (conflict_check_passed=TRUE),
        reviewer_signature_hash CHAR(64) NOT NULL CHECK (reviewer_signature_hash ~ '^[a-fA-F0-9]{64}$'),
        decision_evidence_reference TEXT NOT NULL,
        decided_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS sponsor_org_reviewer_once_per_digest_idx ON ${SCHEMA}.sponsor_organization_reviewer_decisions(mandate_id, reviewer_wallet_address, evidence_set_digest)`)
      await db.query(`CREATE INDEX IF NOT EXISTS sponsor_org_reviewer_decisions_subject_idx ON ${SCHEMA}.sponsor_organization_reviewer_decisions(application_id, mandate_id, decided_at DESC)`)
      await db.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_organization_revocation_events (
        id UUID PRIMARY KEY,
        application_id UUID NOT NULL REFERENCES ${SCHEMA}.sponsor_organization_applications(id),
        mandate_id UUID NULL REFERENCES ${SCHEMA}.sponsor_organization_mandates(id),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('application','mandate')),
        scope_id UUID NOT NULL,
        actor_wallet_address TEXT NOT NULL CHECK (actor_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
        actor_role TEXT NOT NULL CHECK (actor_role IN ('sponsor-representative','security-officer')),
        reason_code TEXT NOT NULL CHECK (reason_code IN ('sponsor-request','suspected-compromise','authority-withdrawn','provider-account-changed','evidence-invalidated','policy-breach','legal-or-compliance-hold','other')),
        emergency BOOLEAN NOT NULL DEFAULT FALSE,
        actor_signature_hash CHAR(64) NOT NULL CHECK (actor_signature_hash ~ '^[a-fA-F0-9]{64}$'),
        event_reference TEXT NOT NULL,
        effective_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((scope_type='application' AND scope_id=application_id AND mandate_id IS NULL) OR (scope_type='mandate' AND mandate_id IS NOT NULL AND scope_id=mandate_id))
      )`)
      await db.query(`CREATE INDEX IF NOT EXISTS sponsor_org_revocations_scope_idx ON ${SCHEMA}.sponsor_organization_revocation_events(scope_type, scope_id, effective_at DESC)`)
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS sponsor_org_revocation_signature_once_idx ON ${SCHEMA}.sponsor_organization_revocation_events(actor_signature_hash)`)
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS sponsor_org_revocation_reference_once_idx ON ${SCHEMA}.sponsor_organization_revocation_events(scope_type,scope_id,actor_wallet_address,event_reference)`)
      await db.query(`CREATE OR REPLACE FUNCTION ${SCHEMA}.reject_sponsor_org_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'sponsor organization governance records are append-only'; END;
      $$`)
      for (const [table, trigger] of [
        ['sponsor_organization_evidence_artifacts','sponsor_org_evidence_immutable'],
        ['sponsor_organization_malware_scan_attestations','sponsor_org_malware_attestations_immutable'],
        ['sponsor_organization_reviewer_decisions','sponsor_org_review_decisions_immutable'],
        ['sponsor_organization_revocation_events','sponsor_org_revocations_immutable'],
      ]) {
        await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${SCHEMA}.${table}`)
        await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON ${SCHEMA}.${table} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.reject_sponsor_org_audit_mutation()`)
      }
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}
function reviewerRegistry(env) { return getSponsorReviewerRegistry(env).entries }
function revocationRegistry(env) { return getSponsorSecurityOfficerRegistry(env).entries }
async function authenticate(req, env, getSession, now) {
  const origin = clean(req.headers?.origin, 512)
  let validOrigin = false
  try { const parsed = new URL(origin); validOrigin = parsed.origin === origin && parsed.protocol === 'https:' } catch {}
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!validOrigin || !configuredOrigins(env).includes(origin) || !match) return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
  let lookup
  try { lookup = await getSession({ tokenHash: hash(match[1]), origin, nowMs: now() }) } catch { lookup = null }
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'wallet-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.origin !== origin || session.expiresAt <= now() || !isValidTronAddress(session.address)) {
    return { ok: false, status: 401, error: 'wallet-session-invalid-or-expired' }
  }
  return { ok: true, address: session.address }
}
function ownerAddress(env) { return clean(env.OWNER_WALLET_ADDRESS, 64) }
function buildEvidenceReviewMessage(input) {
  return [
    'TRON Transfer independent sponsor evidence review',
    'Version: sponsor-evidence-review-v1',
    'Network: TRON Mainnet',
    'Application: ' + input.applicationId,
    'Mandate: ' + input.mandateId,
    'Evidence-set SHA-256: ' + input.evidenceSetDigest,
    'Decision: ' + input.decision,
    'Reviewer wallet: ' + input.reviewerWalletAddress,
    'Reviewer role: ' + input.reviewerRole,
    'Independence attested: true',
    'Conflict check passed: true',
    'Evidence review reference: ' + input.decisionEvidenceReference,
    'Decided at: ' + input.decidedAt,
    'This signature records an evidence review only. It is not a transaction, signer instruction, payout authorization or permission to spend.',
  ].join('\n')
}
function buildRevocationMessage(input) {
  return [
    'TRON Transfer sponsor governance revocation',
    'Version: sponsor-governance-revocation-v1',
    'Application: ' + input.applicationId,
    'Scope: ' + input.scopeType,
    'Scope ID: ' + input.scopeId,
    'Mandate: ' + (input.mandateId || 'none'),
    'Actor wallet: ' + input.actorWalletAddress,
    'Actor role: ' + input.actorRole,
    'Reason: ' + input.reasonCode,
    'Emergency: ' + String(input.emergency),
    'Event reference: ' + input.eventReference,
    'Effective at: ' + input.effectiveAt,
    'This signature records a governance revocation only. It does not submit or authorize a transaction.',
  ].join('\n')
}
async function readEvidenceSet(db, mandateId, env = process.env, nowMs = Date.now()) {
  const result = await db.query(`SELECT e.id, e.application_id, e.mandate_id, e.evidence_type, e.storage_provider, e.object_key,
    e.content_sha256, e.media_type, e.byte_size, e.encrypted_at_rest, e.uploaded_by_wallet, e.retention_policy_reference, e.created_at,
    e.malware_scan_status, e.vault_version_id, e.malware_scanner_version, e.vault_receipt_id, e.vault_receipt_key_id,
    e.vault_receipt_json, e.retention_mode, e.retention_until, e.encryption_mode,
    a.content_sha256 AS attestation_content_sha256, a.scanner_version AS attestation_scanner_version,
    a.scanner_service AS attestation_scanner_service, a.scan_status AS attestation_scan_status,
    a.attestation_key_id, a.attestation_json, a.scanned_at
    FROM ${SCHEMA}.sponsor_organization_evidence_artifacts e
    LEFT JOIN ${SCHEMA}.sponsor_organization_malware_scan_attestations a ON a.evidence_id=e.id
    WHERE e.mandate_id=$1 ORDER BY e.id ASC`, [mandateId])
  const vaultKeys = getSponsorVaultReceiptKeyRegistry(env)
  const scannerKeys = getSponsorScannerAttestationKeyRegistry(env)
  const minRetentionDays = Number(env.SPONSOR_ORG_VAULT_MIN_RETENTION_DAYS)
  const expectedIssuer = clean(env.SPONSOR_ORG_VAULT_RECEIPT_ISSUER, 128)
  const trustConfigReady = vaultKeys.configured && scannerKeys.configured
    && expectedIssuer.length > 0 && Number.isInteger(minRetentionDays) && minRetentionDays >= 1
  const artifacts = result.rows.map((row) => {
    const receipt = row.vault_receipt_json && typeof row.vault_receipt_json === 'object' ? row.vault_receipt_json : null
    const attestation = row.attestation_json && typeof row.attestation_json === 'object' ? row.attestation_json : null
    const scanVerification = attestation && scannerKeys.configured
      ? verifyMalwareScanAttestation(attestation, {
        keyRegistry: scannerKeys.keys,
        expectedSha256: row.content_sha256.trim(),
        expectedByteSize: Number(row.byte_size),
        nowMs,
      })
      : { valid:false, reason:'scanner-attestation-or-trust-config-missing' }
    const receiptVerification = receipt && trustConfigReady && scanVerification.valid
      ? verifyPrivateVaultReceiptV2(receipt, {
        keyRegistry: vaultKeys.keys,
        scannerKeyRegistry: scannerKeys.keys,
        expectedObjectKey: row.object_key,
        expectedSha256: row.content_sha256.trim(),
        expectedByteSize: Number(row.byte_size),
        expectedMediaType: row.media_type,
        expectedOrganizationId: row.application_id,
        expectedIssuer,
        expectedRetentionPolicyReference: row.retention_policy_reference,
        minimumRetentionMs: minRetentionDays * 24 * 60 * 60 * 1000,
        nowMs,
      })
      : { valid:false, reason:'vault-receipt-or-independent-attestation-unavailable' }
    const receiptScanSignature = receipt?.malwareScan?.attestation?.signature
    const persistedScanSignature = attestation?.signature
    const persistedScanMatches = scanVerification.valid === true
      && row.attestation_key_id === scanVerification.keyId
      && row.attestation_scanner_version === scanVerification.scannerVersion
      && row.attestation_scanner_service === 'independent-signed-attestation'
      && row.attestation_scan_status === 'clean'
      && String(row.attestation_content_sha256 || '').trim() === row.content_sha256.trim()
      && persistedScanSignature?.keyId === receiptScanSignature?.keyId
      && persistedScanSignature?.value === receiptScanSignature?.value
      && row.malware_scanner_version === scanVerification.scannerVersion
      && row.scanned_at && new Date(row.scanned_at).getTime() === Date.parse(scanVerification.scannedAt)
    const denormalizedReceiptMatches = receiptVerification.valid === true
      && row.storage_provider === 'approved-private-document-vault'
      && row.encrypted_at_rest === true
      && row.malware_scan_status === 'clean'
      && row.vault_receipt_id === receiptVerification.receiptId
      && row.vault_receipt_key_id === receiptVerification.signingKeyId
      && row.vault_version_id === receiptVerification.objectVersionId
      && row.retention_mode === receiptVerification.retentionMode
      && row.retention_until
      && new Date(row.retention_until).getTime() === Date.parse(receiptVerification.retainUntil)
      && row.encryption_mode === receiptVerification.encryptionMode
    const receiptVerified = persistedScanMatches && denormalizedReceiptMatches
    return {
      id: row.id, applicationId: row.application_id, mandateId: row.mandate_id, evidenceType: row.evidence_type,
      storageProvider: row.storage_provider, objectKey: row.object_key, contentSha256: row.content_sha256.trim(),
      mediaType: row.media_type, byteSize: Number(row.byte_size), encryptedAtRest: row.encrypted_at_rest,
      malwareScanStatus: row.malware_scan_status, vaultVersionId: row.vault_version_id || null,
      malwareScannerVersion: row.malware_scanner_version || null, uploadedByWallet: row.uploaded_by_wallet,
      retentionPolicyReference: row.retention_policy_reference, vaultReceiptId: row.vault_receipt_id || null,
      vaultReceiptKeyId: row.vault_receipt_key_id || null, retentionMode: row.retention_mode || null,
      retentionUntil: row.retention_until ? new Date(row.retention_until).toISOString() : null,
      encryptionMode: row.encryption_mode || null,
      scannerAttestationVerified: persistedScanMatches,
      vaultReceiptV2Verified: receiptVerified,
      vaultReceiptVerificationReason: receiptVerified ? null : (receiptVerification.reason || scanVerification.reason || 'persisted-custody-metadata-mismatch'),
      createdAt: new Date(row.created_at).toISOString(),
    }
  })
  return { artifacts, digest: computeSponsorOrganizationEvidenceSetDigest(artifacts.map((a) => ({ id:a.id, contentSha256:a.contentSha256 }))) }
}

export function createSponsorOrganizationGovernanceRouter({
  env = process.env, getSession = getWalletAuthSession, now = () => Date.now(),
  verifyMessage = async (message, signature) => Trx.verifyMessageV2(message, signature),
  custodyUpload = scanAndStoreEvidenceV2,
} = {}) {
  const router = Router()

  router.get('/organizations/governance/config', async (req, res) => {
    noStore(res)
    const auth = await authenticate(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success:false, error:auth.error })
    const reviewerState = getSponsorReviewerRegistry(env)
    const securityState = getSponsorSecurityOfficerRegistry(env)
    const reviewer = reviewerState.entries.find((item) => item.walletAddress === auth.address)
    const securityOfficer = securityState.entries.some((item) => item.walletAddress === auth.address)
    const custody = getDocumentCustodyV2Config(env)
    return res.json({ success:true, reviewerRole:reviewer?.role || null, securityOfficer,
      reviewerRegistryConfigured:reviewerState.configured, reviewerRegistryVersion:reviewerState.version,
      securityOfficerRegistryConfigured:securityState.configured, securityOfficerRegistryVersion:securityState.version,
      documentCustodyAvailable:custody.ready, documentCustodyMissing:custody.missing, payoutAuthorized:false })
  })

  router.post('/organizations/mandates/:id/evidence', async (req, res) => {
    noStore(res)
    const auth = await authenticate(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const mandateId = clean(req.params?.id, 64)
    if (!UUID_RE.test(mandateId)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['evidenceType','storageProvider','objectKey','contentSha256','mediaType','byteSize','encryptedAtRest','retentionPolicyReference']
    if (Object.keys(body).some((key) => !allowed.includes(key))) return res.status(400).json({ success: false, error: 'unexpected-fields' })
    const evidenceType = clean(body.evidenceType, 64)
    const objectKey = clean(body.objectKey, 512)
    const contentSha256 = clean(body.contentSha256, 64).toLowerCase()
    const mediaType = clean(body.mediaType, 64)
    const byteSize = Number(body.byteSize)
    if (!['legal-entity-registration','beneficial-ownership','authorized-representative','sponsor-wallet-control','provider-account-ownership','provider-signer-policy','signed-agreement','source-of-funds','funding-balance','other'].includes(evidenceType)
      || body.storageProvider !== 'approved-private-document-vault'
      || !objectKey || objectKey.length > 512 || objectKey.startsWith('/') || objectKey.includes('..') || /^https?:\/\//i.test(objectKey)
      || !SHA_RE.test(contentSha256) || !['application/pdf','image/jpeg','image/png'].includes(mediaType)
      || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 20 * 1024 * 1024
      || body.encryptedAtRest !== true || clean(body.retentionPolicyReference, 160).length < 3) {
      return res.status(400).json({ success: false, error: 'invalid-private-vault-evidence-metadata' })
    }
    const db = getDb(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const mandate = await db.query(`SELECT m.id,m.application_id,m.sponsor_wallet_address,m.status,a.sponsor_wallet_address AS app_sponsor
        FROM ${SCHEMA}.sponsor_organization_mandates m JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id
        WHERE m.id=$1 LIMIT 1`, [mandateId])
      const row = mandate.rows[0]
      if (!row) return res.status(404).json({ success: false, error: 'mandate-not-found' })
      if (row.sponsor_wallet_address !== auth.address || row.app_sponsor !== auth.address) return res.status(403).json({ success: false, error: 'sponsor-wallet-required' })
      if (!['signed-awaiting-review','verified','authorized'].includes(row.status)) return res.status(409).json({ success: false, error: 'mandate-not-open-for-evidence' })
      const id = randomUUID()
      await db.query(`INSERT INTO ${SCHEMA}.sponsor_organization_evidence_artifacts
        (id,application_id,mandate_id,evidence_type,storage_provider,object_key,content_sha256,media_type,byte_size,encrypted_at_rest,uploaded_by_wallet,retention_policy_reference)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11)`,
      [id,row.application_id,mandateId,evidenceType,body.storageProvider,objectKey,contentSha256,mediaType,byteSize,auth.address,clean(body.retentionPolicyReference,160)])
      return res.status(201).json({ success: true, evidenceId: id, verificationStatus: 'pending-independent-review',
        rawDocumentStoredHere: false, vaultObjectFetched: false, payoutAuthorized: false,
        note: 'Only metadata and a private vault object reference were stored. The vault object, encryption and malware scan have not been independently inspected by this API.' })
    } catch {
      return res.status(503).json({ success: false, error: 'evidence-metadata-storage-failed' })
    }
  })

  router.post('/organizations/mandates/:id/evidence/upload',
    async (req, res, next) => {
      noStore(res)
      const auth = await authenticate(req, env, getSession, now)
      if (!auth.ok) return res.status(auth.status).json({ success:false, error:auth.error })
      req.sponsorGovernanceAuth = auth
      return next()
    },
    express.raw({ type: ['application/pdf','image/jpeg','image/png'], limit: '20mb' }),
    async (req, res) => {
      const auth = req.sponsorGovernanceAuth
      const mandateId = clean(req.params?.id, 64)
      if (!UUID_RE.test(mandateId)) return res.status(400).json({ success:false, error:'invalid-mandate-id' })
      if (!Buffer.isBuffer(req.body)) return res.status(415).json({ success:false, error:'evidence-content-type-not-allowed' })
      const evidenceType = clean(req.headers['x-evidence-type'], 64)
      const retentionPolicyReference = clean(req.headers['x-retention-policy-reference'], 160)
      const mediaType = clean(req.headers['content-type'], 64).split(';')[0].trim().toLowerCase()
      if (!['legal-entity-registration','beneficial-ownership','authorized-representative','sponsor-wallet-control','provider-account-ownership','provider-signer-policy','signed-agreement','source-of-funds','funding-balance','other'].includes(evidenceType)
        || retentionPolicyReference.length < 3) {
        return res.status(400).json({ success:false, error:'invalid-evidence-upload-metadata' })
      }
      const custody = getDocumentCustodyV2Config(env)
      if (!custody.ready) return res.status(503).json({ success:false, error:'document-custody-not-configured', payoutAuthorized:false })
      const db = getDb(env)
      if (!db) return res.status(503).json({ success:false, error:'database-not-configured' })
      try {
        await ensureSchema(db)
        const mandate = await db.query(`SELECT m.id,m.application_id,m.sponsor_wallet_address,m.status,a.sponsor_wallet_address AS app_sponsor
          FROM ${SCHEMA}.sponsor_organization_mandates m JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id
          WHERE m.id=$1 LIMIT 1`, [mandateId])
        const row = mandate.rows[0]
        if (!row) return res.status(404).json({ success:false, error:'mandate-not-found' })
        if (row.sponsor_wallet_address !== auth.address || row.app_sponsor !== auth.address) return res.status(403).json({ success:false, error:'sponsor-wallet-required' })
        if (!['signed-awaiting-review','verified','authorized'].includes(row.status)) return res.status(409).json({ success:false, error:'mandate-not-open-for-evidence' })
        const stored = await custodyUpload({ buffer:req.body, mediaType, retentionPolicyReference, applicationId:row.application_id,
          mandateId, config:custody, now })
        const evidenceId = randomUUID()
        const client = await db.connect()
        try {
          await client.query('BEGIN')
          await client.query(`INSERT INTO ${SCHEMA}.sponsor_organization_evidence_artifacts
            (id,application_id,mandate_id,evidence_type,storage_provider,object_key,content_sha256,media_type,byte_size,
             encrypted_at_rest,malware_scan_status,uploaded_by_wallet,retention_policy_reference,vault_version_id,malware_scanner_version,
             vault_receipt_id,vault_receipt_key_id,vault_receipt_json,retention_mode,retention_until,encryption_mode)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'clean',$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)`,
          [evidenceId,row.application_id,mandateId,evidenceType,stored.storageProvider,stored.objectKey,stored.contentSha256,
            stored.mediaType,stored.byteSize,auth.address,stored.retentionPolicyReference,stored.vaultVersionId,stored.scanResult.version,
            stored.vaultReceiptId,stored.vaultReceiptKeyId,JSON.stringify(stored.vaultReceipt),stored.retentionMode,stored.retentionUntil,stored.encryptionMode])
          await client.query(`INSERT INTO ${SCHEMA}.sponsor_organization_malware_scan_attestations
            (id,evidence_id,content_sha256,scanner_service,scanner_version,attestation_key_id,attestation_json,scan_status,scanned_at)
            VALUES ($1,$2,$3,'independent-signed-attestation',$4,$5,$6::jsonb,'clean',$7)`,
          [randomUUID(),evidenceId,stored.contentSha256,stored.scanResult.version,stored.scanAttestationKeyId,JSON.stringify(stored.scanAttestation),new Date(stored.scanResult.scannedAt).toISOString()])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally { client.release() }
        return res.status(201).json({ success:true,evidenceId,contentSha256:stored.contentSha256,byteSize:stored.byteSize,
          mediaType:stored.mediaType,malwareScanStatus:'clean',malwareScanner:stored.scanResult.scanner,
          malwareScannerVersion:stored.scanResult.version,vaultObjectStored:true,vaultVersionId:stored.vaultVersionId,
          vaultReceiptV2Verified:true,vaultReceiptId:stored.vaultReceiptId,retentionMode:stored.retentionMode,retentionUntil:stored.retentionUntil,
          encryptionAtRestConfirmed:true,verificationStatus:'pending-independent-review',payoutAuthorized:false,
          transactionBroadcast:false })
      } catch (error) {
        const reason = ['document-custody-v2-not-configured','independent-scanner-service-unavailable','independent-scanner-service-rejected',
          'independent-scan-attestation-invalid','independent-scan-identity-mismatch','private-vault-upload-unavailable','private-vault-upload-rejected',
          'private-vault-receipt-v2-invalid','vault-receipt-scanner-attestation-substitution','evidence-size-out-of-range',
          'evidence-media-type-not-allowed','evidence-content-type-mismatch'].includes(error?.message)
          ? error.message : 'evidence-custody-operation-failed'
        const status = ['malware-detected','independent-scan-attestation-invalid'].includes(reason) ? 422 : 503
        return res.status(status).json({ success:false,error:reason,payoutAuthorized:false,transactionBroadcast:false })
      }
    })

  router.get('/organizations/mandates/:id/governance', async (req, res) => {
    noStore(res)
    const auth = await authenticate(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const mandateId = clean(req.params?.id, 64)
    if (!UUID_RE.test(mandateId)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const db = getDb(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const mandate = await db.query(`SELECT m.id,m.application_id,m.sponsor_wallet_address,a.sponsor_wallet_address AS app_sponsor
        FROM ${SCHEMA}.sponsor_organization_mandates m JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id WHERE m.id=$1`, [mandateId])
      const row = mandate.rows[0]
      if (!row) return res.status(404).json({ success: false, error: 'mandate-not-found' })
      const registry = reviewerRegistry(env)
      const isReviewer = registry.some((r) => r.walletAddress === auth.address)
      const isSecurity = revocationRegistry(env).some((r) => r.walletAddress === auth.address)
      if (auth.address !== row.sponsor_wallet_address && auth.address !== ownerAddress(env) && !isReviewer && !isSecurity) {
        return res.status(403).json({ success: false, error: 'governance-record-access-denied' })
      }
      const evidence = await readEvidenceSet(db, mandateId, env, now())
      const decisions = await db.query(`SELECT reviewer_wallet_address,reviewer_role,evidence_set_digest,decision,decision_evidence_reference,decided_at
        FROM ${SCHEMA}.sponsor_organization_reviewer_decisions WHERE mandate_id=$1 ORDER BY created_at ASC`, [mandateId])
      const revocations = await db.query(`SELECT scope_type,scope_id,actor_wallet_address,actor_role,reason_code,emergency,event_reference,effective_at
        FROM ${SCHEMA}.sponsor_organization_revocation_events WHERE mandate_id=$1 OR (scope_type='application' AND scope_id=$2) ORDER BY created_at ASC`,
      [mandateId,row.application_id])
      const currentDecisions = decisions.rows.filter((d) => d.evidence_set_digest.trim() === evidence.digest)
      const activeDecisions = activeReviewerDecisions(currentDecisions, env)
      const approvedRoles = new Set(activeDecisions.filter((d) => d.decision === 'approved').map((d) => d.reviewer_role))
      const reviewers = new Set(activeDecisions.filter((d) => d.decision === 'approved').map((d) => d.reviewer_wallet_address))
      const custodyMet = evidence.artifacts.length > 0 && evidence.artifacts.every((artifact) => artifact.malwareScanStatus === 'clean' && artifact.vaultVersionId && artifact.malwareScannerVersion && artifact.vaultReceiptV2Verified === true)
      const quorumMet = custodyMet && activeDecisions.every((d) => d.decision === 'approved') && reviewers.size >= 2 && approvedRoles.has('compliance-reviewer') && approvedRoles.has('security-reviewer')
      return res.json({ success: true, applicationId: row.application_id, mandateId, evidence: evidence.artifacts, evidenceSetDigest: evidence.digest,
        reviewerDecisions: decisions.rows.map((d) => ({ reviewerWalletAddress:d.reviewer_wallet_address, reviewerRole:d.reviewer_role,
          evidenceSetDigest:d.evidence_set_digest.trim(), decision:d.decision, decisionEvidenceReference:d.decision_evidence_reference,
          decidedAt:new Date(d.decided_at).toISOString() })),
        independentReview: { quorumMet, custodyVerified:custodyMet, reviewerCount: reviewers.size, requiredRoles:['compliance-reviewer','security-reviewer'] },
        revocations: revocations.rows.map((e) => ({ scopeType:e.scope_type,scopeId:e.scope_id,actorWalletAddress:e.actor_wallet_address,
          actorRole:e.actor_role,reasonCode:e.reason_code,emergency:e.emergency,eventReference:e.event_reference,effectiveAt:new Date(e.effective_at).toISOString() })),
        payoutAuthorized: false, signerOperationPerformed: false, transactionBroadcast: false })
    } catch { return res.status(503).json({ success: false, error: 'governance-record-read-failed' }) }
  })

  // Gate the legacy owner state-transition endpoint: it may record verify/authorize
  // only after the independent two-role quorum approves the exact current digest.
  router.post('/organizations/mandates/:id/review', async (req, res, next) => {
    noStore(res)
    const auth = await authenticate(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success:false, error:auth.error })
    if (!ownerAddress(env) || auth.address !== ownerAddress(env)) {
      return res.status(403).json({ success:false, error:'platform-owner-only' })
    }
    if (!['verify','authorize'].includes(req.body?.decision)) return next()
    const mandateId = clean(req.params?.id, 64)
    if (!UUID_RE.test(mandateId)) return res.status(400).json({ success:false, error:'invalid-mandate-id' })
    const db = getDb(env)
    if (!db) return res.status(503).json({ success:false, error:'database-not-configured' })
    try {
      await ensureSchema(db)
      const mandate = await db.query(`SELECT id FROM ${SCHEMA}.sponsor_organization_mandates WHERE id=$1 LIMIT 1`, [mandateId])
      if (!mandate.rows[0]) return res.status(404).json({ success:false, error:'mandate-not-found' })
      const evidence = await readEvidenceSet(db, mandateId, env, now())
      if (!evidence.digest || evidence.artifacts.length === 0) {
        return res.status(409).json({ success:false, error:'independent-evidence-quorum-required', payoutAuthorized:false })
      }
      if (evidence.artifacts.some((artifact) => artifact.malwareScanStatus !== 'clean' || !artifact.vaultVersionId || !artifact.malwareScannerVersion || artifact.vaultReceiptV2Verified !== true)) {
        return res.status(409).json({ success:false, error:'evidence-custody-and-malware-scan-required', payoutAuthorized:false })
      }
      const decisions = await db.query(`SELECT reviewer_wallet_address,reviewer_role,decision
        FROM ${SCHEMA}.sponsor_organization_reviewer_decisions
        WHERE mandate_id=$1 AND evidence_set_digest=$2`, [mandateId,evidence.digest])
      const activeDecisions = activeReviewerDecisions(decisions.rows, env)
      const approved = activeDecisions.filter((d) => d.decision === 'approved')
      const reviewers = new Set(approved.map((d) => d.reviewer_wallet_address))
      const roles = new Set(approved.map((d) => d.reviewer_role))
      const quorumMet = activeDecisions.every((d) => d.decision === 'approved')
        && reviewers.size >= 2 && roles.has('compliance-reviewer') && roles.has('security-reviewer')
      if (!quorumMet) {
        return res.status(409).json({ success:false, error:'independent-reviewer-quorum-not-met',
          reviewerCount:reviewers.size, requiredRoles:['compliance-reviewer','security-reviewer'], payoutAuthorized:false })
      }
      return next()
    } catch {
      return res.status(503).json({ success:false, error:'independent-review-quorum-check-failed', payoutAuthorized:false })
    }
  })

  router.post('/organizations/mandates/:id/reviews', async (req, res) => {
    noStore(res)
    const auth = await authenticate(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const mandateId = clean(req.params?.id, 64)
    if (!UUID_RE.test(mandateId)) return res.status(400).json({ success: false, error: 'invalid-mandate-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((k) => !['decision','decisionEvidenceReference','decidedAt','signature','independenceAttested','conflictCheckPassed'].includes(k))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const decision = body.decision
    const reference = clean(body.decisionEvidenceReference, 160)
    const decidedAt = new Date(body.decidedAt)
    if (!['approved','rejected','needs-more-evidence'].includes(decision) || reference.length < 8
      || !Number.isFinite(decidedAt.getTime()) || Math.abs(now() - decidedAt.getTime()) > 5 * 60 * 1000
      || body.independenceAttested !== true || body.conflictCheckPassed !== true) {
      return res.status(400).json({ success: false, error: 'invalid-independent-review-decision' })
    }
    const reviewer = reviewerRegistry(env).find((r) => r.walletAddress === auth.address)
    if (!reviewer) return res.status(403).json({ success: false, error: 'reviewer-not-in-trusted-server-registry' })
    const db = getDb(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const mandate = await db.query(`SELECT m.id,m.application_id,m.sponsor_wallet_address,a.sponsor_wallet_address AS app_sponsor
        FROM ${SCHEMA}.sponsor_organization_mandates m JOIN ${SCHEMA}.sponsor_organization_applications a ON a.id=m.application_id WHERE m.id=$1`, [mandateId])
      const row = mandate.rows[0]
      if (!row) return res.status(404).json({ success: false, error: 'mandate-not-found' })
      if (auth.address === row.sponsor_wallet_address || auth.address === row.app_sponsor) return res.status(403).json({ success: false, error: 'sponsor-cannot-review-own-evidence' })
      const evidence = await readEvidenceSet(db, mandateId, env, now())
      if (!evidence.digest || evidence.artifacts.length === 0) return res.status(409).json({ success: false, error: 'evidence-set-empty' })
      if (evidence.artifacts.some((artifact) => artifact.malwareScanStatus !== 'clean' || !artifact.vaultVersionId || !artifact.malwareScannerVersion || artifact.vaultReceiptV2Verified !== true)) {
        return res.status(409).json({ success:false, error:'evidence-custody-and-malware-scan-required', payoutAuthorized:false })
      }
      const messageInput = { applicationId:row.application_id, mandateId, evidenceSetDigest:evidence.digest, decision,
        reviewerWalletAddress:auth.address, reviewerRole:reviewer.role, decisionEvidenceReference:reference, decidedAt:decidedAt.toISOString() }
      const message = buildEvidenceReviewMessage(messageInput)
      let signer
      try { signer = await verifyMessage(message, body.signature) } catch { signer = null }
      if (signer !== auth.address) return res.status(401).json({ success: false, error: 'reviewer-signature-address-mismatch' })
      await db.query(`INSERT INTO ${SCHEMA}.sponsor_organization_reviewer_decisions
        (id,application_id,mandate_id,reviewer_wallet_address,reviewer_role,evidence_set_digest,decision,independence_attested,conflict_check_passed,reviewer_signature_hash,decision_evidence_reference,decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,$8,$9,$10)`,
      [randomUUID(),row.application_id,mandateId,auth.address,reviewer.role,evidence.digest,decision,hash(body.signature),reference,decidedAt.toISOString()])
      const decisions = await db.query(`SELECT reviewer_wallet_address,reviewer_role,decision FROM ${SCHEMA}.sponsor_organization_reviewer_decisions
        WHERE mandate_id=$1 AND evidence_set_digest=$2`, [mandateId,evidence.digest])
      const activeDecisions = activeReviewerDecisions(decisions.rows, env)
      const approved = activeDecisions.filter((d) => d.decision === 'approved')
      const distinct = new Set(approved.map((d) => d.reviewer_wallet_address))
      const roles = new Set(approved.map((d) => d.reviewer_role))
      const quorumMet = activeDecisions.every((d) => d.decision === 'approved') && distinct.size >= 2 && roles.has('compliance-reviewer') && roles.has('security-reviewer')
      return res.status(201).json({ success:true, decisionId:undefined, evidenceSetDigest:evidence.digest,
        independentReview:{ quorumMet, reviewerCount:distinct.size, requiredRoles:['compliance-reviewer','security-reviewer'] },
        payoutAuthorized:false, signerOperationPerformed:false, transactionBroadcast:false })
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ success:false, error:'reviewer-already-decided-for-evidence-digest' })
      return res.status(503).json({ success:false, error:'independent-review-storage-failed' })
    }
  })

  async function recordRevocation(req, res, scopeType) {
    noStore(res)
    const auth = await authenticate(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success:false, error:auth.error })
    const scopeId = clean(req.params?.id, 64)
    if (!UUID_RE.test(scopeId)) return res.status(400).json({ success:false, error:'invalid-governance-scope-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((k) => !['reasonCode','eventReference','emergency','signature','effectiveAt'].includes(k))) {
      return res.status(400).json({ success:false, error:'unexpected-fields' })
    }
    const reasonCode = body.reasonCode
    const eventReference = clean(body.eventReference, 160)
    const emergency = body.emergency === true
    const effectiveAt = new Date(body.effectiveAt)
    if (!REVOCATION_REASONS.has(reasonCode) || eventReference.length < 8
      || !Number.isFinite(effectiveAt.getTime()) || Math.abs(now() - effectiveAt.getTime()) > 5 * 60 * 1000) {
      return res.status(400).json({ success:false, error:'invalid-revocation-event' })
    }
    const db = getDb(env)
    if (!db) return res.status(503).json({ success:false, error:'database-not-configured' })
    try {
      await ensureSchema(db)
      const lookup = scopeType === 'mandate'
        ? await db.query(`SELECT m.id AS mandate_id,m.application_id,m.sponsor_wallet_address FROM ${SCHEMA}.sponsor_organization_mandates m WHERE m.id=$1`, [scopeId])
        : await db.query(`SELECT id AS application_id,sponsor_wallet_address FROM ${SCHEMA}.sponsor_organization_applications WHERE id=$1`, [scopeId])
      const row = lookup.rows[0]
      if (!row) return res.status(404).json({ success:false, error:'governance-scope-not-found' })
      const sponsor = row.sponsor_wallet_address === auth.address
      const security = revocationRegistry(env).some((a) => a.walletAddress === auth.address)
      if (emergency ? !security : !sponsor) return res.status(403).json({ success:false, error:emergency ? 'trusted-security-officer-required' : 'sponsor-wallet-required-for-revocation' })
      const actorRole = emergency ? 'security-officer' : 'sponsor-representative'
      if (emergency && body.emergency !== true) return res.status(400).json({ success:false, error:'emergency-flag-required' })
      const input = { applicationId:row.application_id, scopeType, scopeId, mandateId:scopeType === 'mandate' ? row.mandate_id : null,
        actorWalletAddress:auth.address, actorRole, reasonCode, emergency, eventReference, effectiveAt:effectiveAt.toISOString() }
      const message = buildRevocationMessage(input)
      let signer
      try { signer = await verifyMessage(message, body.signature) } catch { signer = null }
      if (signer !== auth.address) return res.status(401).json({ success:false, error:'revocation-signature-address-mismatch' })
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO ${SCHEMA}.sponsor_organization_revocation_events
          (id,application_id,mandate_id,scope_type,scope_id,actor_wallet_address,actor_role,reason_code,emergency,actor_signature_hash,event_reference,effective_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(),row.application_id,scopeType === 'mandate' ? row.mandate_id : null,scopeType,scopeId,auth.address,actorRole,reasonCode,emergency,hash(body.signature),eventReference,effectiveAt.toISOString()])
        if (scopeType === 'mandate') {
          await client.query(`UPDATE ${SCHEMA}.sponsor_organization_mandates SET status='revoked',updated_at=now()
            WHERE id=$1 AND status IN ('signed-awaiting-review','verified','authorized')`, [scopeId])
        } else {
          await client.query(`UPDATE ${SCHEMA}.sponsor_organization_mandates SET status='revoked',updated_at=now()
            WHERE application_id=$1 AND status IN ('signed-awaiting-review','verified','authorized')`, [scopeId])
          await client.query(`UPDATE ${SCHEMA}.sponsor_organization_applications SET status='closed',updated_at=now() WHERE id=$1`, [scopeId])
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      return res.status(201).json({ success:true, revocationRecorded:true, scopeType, scopeId, payoutAuthorized:false,
        signerOperationPerformed:false, transactionBroadcast:false, note:'Signed revocation event recorded append-only; related mandate records were marked revoked.' })
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ success:false, error:'revocation-event-already-recorded' })
      return res.status(503).json({ success:false, error:'revocation-event-storage-failed' })
    }
  }
  router.post('/organizations/mandates/:id/revoke', (req,res) => recordRevocation(req,res,'mandate'))
  router.post('/organizations/applications/:id/revoke', (req,res) => recordRevocation(req,res,'application'))

  return router
}

export default createSponsorOrganizationGovernanceRouter()
