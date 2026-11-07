import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSponsorOrganizationAuthorization } from '../server/sponsor-organization-authorization.mjs'

const nowMs = Date.parse('2026-11-07T12:00:00.000Z')
const application = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  sponsorWalletAddress: 'T123456789ABCDEFGHJKLMNPQRSTUVWXYZab',
  status: 'accepted-for-due-diligence',
}
const mandate = {
  applicationId: application.id,
  sponsorWalletAddress: application.sponsorWalletAddress,
  agreementDigest: 'a'.repeat(64),
  providerAccountId: 'org-vault-123',
  providerSignerPolicyReference: 'policy-456',
  purpose: 'both',
  executionMode: 'per-transfer',
  perPayoutLimitBaseUnits: '1000000',
  dailyLimitBaseUnits: '5000000',
  validFrom: '2026-11-01T00:00:00.000Z',
  validUntil: '2026-12-01T00:00:00.000Z',
  status: 'authorized',
}
const evidence = {
  applicationId: application.id,
  sponsorWalletAddress: application.sponsorWalletAddress,
  agreementDigest: mandate.agreementDigest,
  providerAccountId: mandate.providerAccountId,
  providerSignerPolicyReference: mandate.providerSignerPolicyReference,
  agreementDigestVerified: true,
  mandateSignatureVerified: true,
  signatureIntentBindingVerified: true,
  legalEntityVerified: true,
  beneficialOwnershipVerified: true,
  walletControlVerified: true,
  reviewerIndependent: true,
  reviewEvidenceReference: 'review-evidence-2026-001',
  providerAccountIdentityVerified: true,
  providerSignerPolicyVerified: true,
  sponsorFundingVerified: true,
  mainnetSandboxIsolationVerified: true,
}

test('passes only the non-production evidence preflight and never authorizes execution', () => {
  const result = evaluateSponsorOrganizationAuthorization({ application, mandate, evidence, nowMs })
  assert.equal(result.eligibleForNonProductionReview, true)
  assert.equal(result.status, 'nonproduction-preflight-passed-not-authorized')
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.signerOperationPerformed, false)
  assert.equal(result.providerRequestPerformed, false)
  assert.equal(result.transactionBroadcast, false)
})

test('fails closed when any independent identity, ownership, wallet, mandate or signer evidence is missing', () => {
  const cases = [
    ['legalEntityVerified', 'legal-entity-not-independently-verified'],
    ['beneficialOwnershipVerified', 'beneficial-ownership-not-independently-verified'],
    ['walletControlVerified', 'organization-wallet-control-not-independently-verified'],
    ['mandateSignatureVerified', 'mandate-signature-not-cryptographically-verified'],
    ['signatureIntentBindingVerified', 'mandate-signature-intent-binding-unverified'],
    ['providerAccountIdentityVerified', 'provider-account-identity-unverified'],
    ['providerSignerPolicyVerified', 'provider-signer-policy-unverified'],
    ['sponsorFundingVerified', 'sponsor-principal-and-fee-funding-unverified'],
    ['mainnetSandboxIsolationVerified', 'sandbox-mainnet-isolation-unverified'],
  ]
  for (const [key, blocker] of cases) {
    const result = evaluateSponsorOrganizationAuthorization({
      application, mandate, evidence: { ...evidence, [key]: false }, nowMs,
    })
    assert.equal(result.eligibleForNonProductionReview, false, key)
    assert.ok(result.blockers.includes(blocker), key)
  }
})

test('rejects unreviewed applications, unapproved mandates and cross-application or wallet substitution', () => {
  const cases = [
    [{ ...application, status: 'pending-review' }, mandate, 'organization-application-not-reviewed-for-due-diligence'],
    [application, { ...mandate, status: 'signed-awaiting-review' }, 'organization-mandate-not-authorized'],
    [application, { ...mandate, applicationId: '123e4567-e89b-42d3-a456-426614174001' }, 'mandate-application-binding-mismatch'],
    [application, { ...mandate, sponsorWalletAddress: 'T1111111111111111111111111111111111' }, 'mandate-application-wallet-mismatch'],
  ]
  for (const [app, signedMandate, blocker] of cases) {
    const result = evaluateSponsorOrganizationAuthorization({ application: app, mandate: signedMandate, evidence, nowMs })
    assert.ok(result.blockers.includes(blocker), blocker)
  }
})

test('rejects malformed, reversed, expired or future mandate windows and unsafe limits', () => {
  const cases = [
    [{ ...mandate, validUntil: 'not-a-date' }, 'mandate-not-currently-valid'],
    [{ ...mandate, validUntil: '2026-11-07T11:59:59.000Z' }, 'mandate-not-currently-valid'],
    [{ ...mandate, validFrom: '2026-11-08T00:00:00.000Z' }, 'mandate-not-currently-valid'],
    [{ ...mandate, perPayoutLimitBaseUnits: '0' }, 'mandate-limits-invalid'],
    [{ ...mandate, dailyLimitBaseUnits: '999999' }, 'mandate-daily-limit-below-per-payout-limit'],
  ]
  for (const [signedMandate, blocker] of cases) {
    const result = evaluateSponsorOrganizationAuthorization({ application, mandate: signedMandate, evidence, nowMs })
    assert.ok(result.blockers.includes(blocker), blocker)
  }
})

test('rejects standing provider mandates until a separately reviewed adapter exists', () => {
  const result = evaluateSponsorOrganizationAuthorization({
    application, mandate: { ...mandate, executionMode: 'fincra-automatic' }, evidence, nowMs,
  })
  assert.ok(result.blockers.includes('standing-provider-authorization-not-supported-by-nonproduction-evaluator'))
  assert.equal(result.payoutAuthorized, false)
})

test('owner-entered review status alone cannot substitute for independent evidence', () => {
  const result = evaluateSponsorOrganizationAuthorization({
    application, mandate,
    evidence: { reviewEvidenceReference: 'owner-entered-reference' },
    nowMs,
  })
  assert.equal(result.eligibleForNonProductionReview, false)
  assert.ok(result.blockers.includes('legal-entity-not-independently-verified'))
  assert.ok(result.blockers.includes('beneficial-ownership-not-independently-verified'))
  assert.ok(result.blockers.includes('mandate-signature-not-cryptographically-verified'))
})


test('rejects evidence copied from another application, wallet, agreement or provider policy', () => {
  const cases = [
    ['applicationId', '123e4567-e89b-42d3-a456-426614174001', 'evidence-application-binding-mismatch'],
    ['sponsorWalletAddress', 'T1111111111111111111111111111111111', 'evidence-sponsor-wallet-binding-mismatch'],
    ['agreementDigest', 'b'.repeat(64), 'evidence-agreement-digest-binding-mismatch'],
    ['providerAccountId', 'another-vault', 'evidence-provider-account-binding-mismatch'],
    ['providerSignerPolicyReference', 'another-policy', 'evidence-provider-signer-policy-binding-mismatch'],
  ]
  for (const [key, value, blocker] of cases) {
    const result = evaluateSponsorOrganizationAuthorization({
      application, mandate, evidence: { ...evidence, [key]: value }, nowMs,
    })
    assert.equal(result.eligibleForNonProductionReview, false, key)
    assert.ok(result.blockers.includes(blocker), key)
  }
})
