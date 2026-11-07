import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSponsorOrganizationEvidenceArtifact,
  evaluateIndependentSponsorOrganizationReview,
  evaluateSponsorOrganizationRevocation,
} from '../server/sponsor-organization-governance.mjs'

const appId = '123e4567-e89b-42d3-a456-426614174000'
const mandateId = '123e4567-e89b-42d3-a456-426614174001'
const sponsor = 'T123456789ABCDEFGHJKLMNPQRSTUVWXYZab'
const uploader = 'T1111111111111111111111111111111111'
const reviewerA = 'T2222222222222222222222222222222222'
const reviewerB = 'T3333333333333333333333333333333333'
const nowMs = Date.parse('2026-11-07T12:00:00.000Z')
const digest = 'a'.repeat(64)

function artifact(id = mandateId) {
  return {
    id, applicationId: appId, mandateId, evidenceType: 'signed-agreement',
    storageProvider: 'approved-private-document-vault', objectKey: 'sponsor-evidence/case-123/agreement.pdf',
    contentSha256: digest, mediaType: 'application/pdf', byteSize: 4096,
    encryptedAtRest: true, malwareScanStatus: 'clean', uploadedByWallet: uploader,
    retentionPolicyReference: 'retention-policy-v1', verificationStatus: 'verified',
  }
}
function approval(wallet, role) {
  return {
    applicationId: appId, mandateId, reviewerWalletAddress: wallet, reviewerRole: role,
    evidenceSetDigest: digest, decision: 'approved', independenceAttested: true,
    conflictCheckPassed: true, signatureVerified: true,
    decisionEvidenceReference: 'review-case-123', decidedAt: '2026-11-07T11:00:00.000Z',
  }
}
const application = {
  id: appId, sponsorWalletAddress: sponsor, submittedByWalletAddress: uploader, status: 'accepted-for-due-diligence',
}
const mandate = { id: mandateId, status: 'authorized', emergencyHold: false }

test('evidence metadata accepts only encrypted, private, scanned and bounded artifacts', () => {
  const result = validateSponsorOrganizationEvidenceArtifact(artifact())
  assert.equal(result.valid, true)
  assert.equal(result.rawDocumentStoredHere, false)
  assert.equal(result.payoutAuthorized, false)
})

test('evidence metadata rejects public URLs, traversal, unencrypted data and credential material', () => {
  const cases = [
    [{ objectKey: 'https://public.example/file.pdf' }, 'evidence-object-key-invalid'],
    [{ objectKey: '../outside.pdf' }, 'evidence-object-key-invalid'],
    [{ encryptedAtRest: false }, 'evidence-not-encrypted-at-rest'],
    [{ containsRawCredentialMaterial: true }, 'credential-material-must-not-be-stored-as-evidence'],
    [{ malwareScanStatus: 'pending' }, 'evidence-malware-scan-not-clean'],
    [{ byteSize: 50 * 1024 * 1024 }, 'evidence-size-out-of-range'],
  ]
  for (const [change, blocker] of cases) {
    const result = validateSponsorOrganizationEvidenceArtifact({ ...artifact(), ...change })
    assert.equal(result.valid, false)
    assert.ok(result.blockers.includes(blocker))
  }
})

test('independent review requires two distinct allowlisted reviewers bound to the exact evidence set', () => {
  const result = evaluateIndependentSponsorOrganizationReview({
    application, mandate, artifacts: [artifact()], approvals: [
      approval(reviewerA, 'compliance-reviewer'), approval(reviewerB, 'security-reviewer'),
    ],
    reviewerRegistry: [
      { walletAddress: reviewerA, role: 'compliance-reviewer', active: true },
      { walletAddress: reviewerB, role: 'security-reviewer', active: true },
    ],
    expectedEvidenceSetDigest: digest, nowMs,
  })
  assert.equal(result.independentlyApproved, true)
  assert.equal(result.reviewerCount, 2)
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.transactionBroadcast, false)
})

test('review rejects sponsor/self review, inactive or unlisted reviewers, and evidence substitution', () => {
  const result = evaluateIndependentSponsorOrganizationReview({
    application, mandate, artifacts: [artifact()],
    approvals: [
      approval(sponsor, 'compliance-reviewer'),
      approval(reviewerA, 'compliance-reviewer'),
      approval(reviewerB, 'security-reviewer'),
    ],
    reviewerRegistry: [
      { walletAddress: reviewerA, role: 'compliance-reviewer', active: true },
      { walletAddress: reviewerB, role: 'security-reviewer', active: false },
    ],
    expectedEvidenceSetDigest: digest, nowMs,
  })
  assert.equal(result.independentlyApproved, false)
  assert.ok(result.blockers.includes('independent-reviewer-quorum-not-met'))
})

test('review fails when any artifact is not verified or belongs to another application', () => {
  const result = evaluateIndependentSponsorOrganizationReview({
    application, artifacts: [{ ...artifact(), verificationStatus: 'pending', applicationId: mandateId }],
    approvals: [], reviewerRegistry: [], expectedEvidenceSetDigest: digest, nowMs,
  })
  assert.ok(result.blockers.includes('review-evidence-application-mismatch'))
  assert.ok(result.blockers.includes('review-evidence-not-independently-verified'))
})

test('application-wide and mandate-specific emergency revocation override all approvals', () => {
  const event = {
    applicationId: appId, scopeType: 'mandate', scopeId: mandateId,
    actorWalletAddress: reviewerA, actorRole: 'security-officer',
    reasonCode: 'suspected-compromise', emergency: true,
    actorSignatureVerified: true, eventReference: 'incident-2026-001',
    effectiveAt: '2026-11-07T11:30:00.000Z',
  }
  const result = evaluateSponsorOrganizationRevocation({
    application, mandate, revocationEvents: [event], nowMs,
  })
  assert.equal(result.active, false)
  assert.ok(result.blockers.includes('organization-or-mandate-revoked'))
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.signerOperationPerformed, false)
})

test('revocation rejects unverified, future-dated or unrelated events', () => {
  const event = {
    applicationId: appId, scopeType: 'mandate', scopeId: mandateId,
    actorWalletAddress: reviewerA, actorRole: 'security-officer',
    reasonCode: 'suspected-compromise', actorSignatureVerified: false,
    eventReference: 'incident-2026-002', effectiveAt: '2026-11-07T11:30:00.000Z',
  }
  const result = evaluateSponsorOrganizationRevocation({
    application, mandate, revocationEvents: [event], nowMs,
  })
  assert.equal(result.active, true)
  assert.equal(result.revocationEventCount, 0)
})

test('an inactive mandate or emergency hold is blocked even without an event', () => {
  const result = evaluateSponsorOrganizationRevocation({
    application, mandate: { ...mandate, emergencyHold: true }, revocationEvents: [], nowMs,
  })
  assert.equal(result.active, false)
  assert.ok(result.blockers.includes('mandate-emergency-hold-active'))
})
