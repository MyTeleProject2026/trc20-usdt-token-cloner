const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[a-f0-9]{64}$/i
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const EVIDENCE_TYPES = new Set([
  'legal-entity-registration', 'beneficial-ownership', 'authorized-representative',
  'sponsor-wallet-control', 'provider-account-ownership', 'provider-signer-policy',
  'signed-agreement', 'source-of-funds', 'funding-balance', 'other',
])
const REVIEWER_ROLES = new Set(['compliance-reviewer', 'security-reviewer'])
const REVOCATION_ACTOR_ROLES = new Set(['sponsor-representative', 'independent-reviewer', 'security-officer'])
const REVOCATION_REASONS = new Set([
  'sponsor-request', 'suspected-compromise', 'authority-withdrawn', 'provider-account-changed',
  'evidence-invalidated', 'policy-breach', 'legal-or-compliance-hold', 'other',
])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function unique(values) {
  return [...new Set(values)]
}

/**
 * Validate metadata for an encrypted, private evidence object.
 * Raw documents and personal data must remain in an approved private document
 * vault; this application stores only a non-public object key and integrity
 * metadata. This function never uploads or reads an object.
 */
export function validateSponsorOrganizationEvidenceArtifact(input = {}) {
  const blockers = []
  if (!UUID_RE.test(String(input.id || ''))) blockers.push('evidence-id-invalid')
  if (!UUID_RE.test(String(input.applicationId || ''))) blockers.push('evidence-application-id-invalid')
  if (input.mandateId != null && !UUID_RE.test(String(input.mandateId))) blockers.push('evidence-mandate-id-invalid')
  if (!EVIDENCE_TYPES.has(input.evidenceType)) blockers.push('evidence-type-invalid')
  if (!SHA256_RE.test(String(input.contentSha256 || ''))) blockers.push('evidence-content-digest-invalid')
  if (input.storageProvider !== 'approved-private-document-vault') blockers.push('evidence-storage-provider-not-approved')
  if (!nonEmpty(input.objectKey) || input.objectKey.length > 512
    || input.objectKey.startsWith('/') || input.objectKey.includes('..')
    || /^https?:\/\//i.test(input.objectKey)) blockers.push('evidence-object-key-invalid')
  if (input.encryptedAtRest !== true) blockers.push('evidence-not-encrypted-at-rest')
  if (input.malwareScanStatus !== 'clean') blockers.push('evidence-malware-scan-not-clean')
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(input.mediaType)) blockers.push('evidence-media-type-not-allowed')
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 20 * 1024 * 1024) blockers.push('evidence-size-out-of-range')
  if (!TRON_ADDRESS_RE.test(String(input.uploadedByWallet || ''))) blockers.push('evidence-uploader-wallet-invalid')
  if (!nonEmpty(input.retentionPolicyReference) || input.retentionPolicyReference.length > 160) blockers.push('evidence-retention-policy-reference-missing')
  if (input.containsRawCredentialMaterial === true) blockers.push('credential-material-must-not-be-stored-as-evidence')
  const reasons = unique(blockers)
  return {
    valid: reasons.length === 0,
    status: reasons.length === 0 ? 'metadata-valid-pending-independent-verification' : 'rejected',
    blockers: reasons,
    rawDocumentStoredHere: false,
    payoutAuthorized: false,
  }
}

/**
 * Evaluate independent reviewer decisions against the exact evidence-set
 * digest. Two distinct, active reviewers are required; neither may be the
 * sponsor wallet nor the evidence submitter. The reviewer registry is supplied
 * by trusted server configuration, never by a request body.
 */
export function evaluateIndependentSponsorOrganizationReview({
  application = {},
  mandate = null,
  artifacts = [],
  approvals = [],
  reviewerRegistry = [],
  expectedEvidenceSetDigest = '',
  nowMs = Date.now(),
  requiredApprovals = 2,
} = {}) {
  const blockers = []
  if (!UUID_RE.test(String(application.id || ''))) blockers.push('review-application-id-invalid')
  if (!TRON_ADDRESS_RE.test(String(application.sponsorWalletAddress || ''))) blockers.push('review-sponsor-wallet-invalid')
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 2 || requiredApprovals > 5) blockers.push('review-quorum-invalid')
  if (!SHA256_RE.test(String(expectedEvidenceSetDigest || ''))) blockers.push('review-evidence-set-digest-invalid')
  if (!Number.isFinite(nowMs)) blockers.push('review-time-invalid')
  if (!Array.isArray(artifacts) || artifacts.length === 0) blockers.push('review-evidence-set-empty')

  const artifactIds = new Set()
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!UUID_RE.test(String(artifact?.id || '')) || artifactIds.has(artifact.id)) blockers.push('review-evidence-id-invalid-or-duplicated')
    artifactIds.add(artifact?.id)
    if (artifact?.applicationId !== application.id) blockers.push('review-evidence-application-mismatch')
    if (artifact?.verificationStatus !== 'verified' || artifact?.malwareScanStatus !== 'clean') blockers.push('review-evidence-not-independently-verified')
    if (!SHA256_RE.test(String(artifact?.contentSha256 || ''))) blockers.push('review-evidence-content-digest-invalid')
  }

  const reviewers = new Map()
  for (const reviewer of Array.isArray(reviewerRegistry) ? reviewerRegistry : []) {
    if (TRON_ADDRESS_RE.test(String(reviewer?.walletAddress || ''))
      && REVIEWER_ROLES.has(reviewer?.role) && reviewer?.active === true) {
      reviewers.set(reviewer.walletAddress, reviewer)
    }
  }

  const accepted = []
  for (const approval of Array.isArray(approvals) ? approvals : []) {
    if (approval?.decision !== 'approved') continue
    const reviewer = reviewers.get(approval.reviewerWalletAddress)
    if (!reviewer || approval.reviewerRole !== reviewer.role) continue
    if (approval.applicationId !== application.id
      || approval.evidenceSetDigest !== expectedEvidenceSetDigest
      || approval.independenceAttested !== true
      || approval.conflictCheckPassed !== true
      || approval.signatureVerified !== true
      || !nonEmpty(approval.decisionEvidenceReference)
      || !Number.isFinite(Date.parse(approval.decidedAt))
      || Date.parse(approval.decidedAt) > nowMs) continue
    if (approval.reviewerWalletAddress === application.sponsorWalletAddress
      || approval.reviewerWalletAddress === application.submittedByWalletAddress) continue
    if (mandate && approval.mandateId !== mandate.id) continue
    accepted.push(approval.reviewerWalletAddress)
  }

  const distinctReviewers = unique(accepted)
  if (distinctReviewers.length < requiredApprovals) blockers.push('independent-reviewer-quorum-not-met')
  const reasons = unique(blockers)
  return {
    independentlyApproved: reasons.length === 0,
    status: reasons.length === 0 ? 'independent-review-quorum-met-not-payout-authorized' : 'blocked',
    reviewerCount: distinctReviewers.length,
    requiredApprovals: Number.isInteger(requiredApprovals) ? requiredApprovals : null,
    blockers: reasons,
    payoutAuthorized: false,
    signerOperationPerformed: false,
    providerRequestPerformed: false,
    transactionBroadcast: false,
  }
}

/**
 * Revocation is monotonic and overrides all approvals. An application-scoped
 * event revokes every mandate under that application. Emergency holds are
 * effective immediately once their trusted event is recorded.
 */
export function evaluateSponsorOrganizationRevocation({
  application = {},
  mandate = {},
  revocationEvents = [],
  nowMs = Date.now(),
} = {}) {
  const blockers = []
  const appId = application.id
  const mandateId = mandate.id
  if (!UUID_RE.test(String(appId || ''))) blockers.push('revocation-application-id-invalid')
  if (!UUID_RE.test(String(mandateId || ''))) blockers.push('revocation-mandate-id-invalid')
  if (!Number.isFinite(nowMs)) blockers.push('revocation-time-invalid')

  const applicable = (Array.isArray(revocationEvents) ? revocationEvents : []).filter((event) => {
    if (event?.applicationId !== appId) return false
    if (event.scopeType === 'application') return event.scopeId === appId
    return event.scopeType === 'mandate' && event.scopeId === mandateId
  }).filter((event) => {
    const effectiveAt = Date.parse(event.effectiveAt)
    return Number.isFinite(effectiveAt) && effectiveAt <= nowMs
      && REVOCATION_ACTOR_ROLES.has(event.actorRole)
      && TRON_ADDRESS_RE.test(String(event.actorWalletAddress || ''))
      && REVOCATION_REASONS.has(event.reasonCode)
      && event.actorSignatureVerified === true
      && nonEmpty(event.eventReference)
  })

  if (applicable.length > 0) blockers.push('organization-or-mandate-revoked')
  if (application.status === 'suspended' || application.status === 'closed' || application.status === 'declined') {
    blockers.push('organization-application-inactive')
  }
  if (mandate.status === 'revoked' || mandate.status === 'declined' || mandate.status === 'expired') {
    blockers.push('mandate-inactive')
  }
  if (mandate.emergencyHold === true) blockers.push('mandate-emergency-hold-active')
  const reasons = unique(blockers)
  return {
    active: reasons.length === 0,
    status: reasons.length === 0 ? 'not-revoked' : 'revoked-or-held',
    revocationEventCount: applicable.length,
    blockers: reasons,
    payoutAuthorized: false,
    signerOperationPerformed: false,
    providerRequestPerformed: false,
    transactionBroadcast: false,
  }
}
