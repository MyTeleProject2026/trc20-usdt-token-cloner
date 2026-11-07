const DIGEST_RE = /^[a-f0-9]{64}$/i
const POSITIVE_BASE_UNITS_RE = /^[1-9][0-9]{0,77}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Fail-closed organizational sponsor evidence evaluator.
 *
 * This is a pure, non-production preflight contract. Its evidence object must
 * be assembled by independently trusted server-side verifiers; HTTP request
 * fields and owner-entered review references are not proof. A passing result
 * never authorizes a payout, signer operation, provider call, or broadcast.
 */
export function evaluateSponsorOrganizationAuthorization({
  application = {},
  mandate = {},
  evidence = {},
  nowMs = Date.now(),
} = {}) {
  const blockers = []
  const applicationId = application.id
  const wallet = application.sponsorWalletAddress
  const mandateWallet = mandate.sponsorWalletAddress

  if (!UUID_RE.test(String(applicationId || ''))) blockers.push('organization-application-id-invalid')
  if (application.status !== 'accepted-for-due-diligence') blockers.push('organization-application-not-reviewed-for-due-diligence')
  if (!nonEmpty(wallet) || wallet !== mandateWallet) blockers.push('mandate-application-wallet-mismatch')
  if (mandate.applicationId !== applicationId) blockers.push('mandate-application-binding-mismatch')

  if (mandate.status !== 'authorized') blockers.push('organization-mandate-not-authorized')
  if (!DIGEST_RE.test(String(mandate.agreementDigest || ''))) blockers.push('agreement-digest-invalid')
  if (evidence.agreementDigestVerified !== true) blockers.push('agreement-document-digest-not-independently-verified')
  if (evidence.mandateSignatureVerified !== true) blockers.push('mandate-signature-not-cryptographically-verified')
  if (evidence.signatureIntentBindingVerified !== true) blockers.push('mandate-signature-intent-binding-unverified')

  if (evidence.legalEntityVerified !== true) blockers.push('legal-entity-not-independently-verified')
  if (evidence.beneficialOwnershipVerified !== true) blockers.push('beneficial-ownership-not-independently-verified')
  if (evidence.walletControlVerified !== true) blockers.push('organization-wallet-control-not-independently-verified')
  if (evidence.reviewerIndependent !== true) blockers.push('independent-reviewer-not-established')
  if (!nonEmpty(evidence.reviewEvidenceReference)) blockers.push('independent-review-evidence-reference-missing')

  if (!['asset-principal', 'network-fees', 'both'].includes(mandate.purpose)) {
    blockers.push('mandate-purpose-invalid')
  }
  if (!POSITIVE_BASE_UNITS_RE.test(String(mandate.perPayoutLimitBaseUnits || ''))
    || !POSITIVE_BASE_UNITS_RE.test(String(mandate.dailyLimitBaseUnits || ''))) {
    blockers.push('mandate-limits-invalid')
  } else if (BigInt(mandate.dailyLimitBaseUnits) < BigInt(mandate.perPayoutLimitBaseUnits)) {
    blockers.push('mandate-daily-limit-below-per-payout-limit')
  }

  const validFrom = Date.parse(mandate.validFrom)
  const validUntil = Date.parse(mandate.validUntil)
  if (!Number.isFinite(nowMs) || !Number.isFinite(validFrom) || !Number.isFinite(validUntil)
    || validFrom > nowMs || validUntil <= nowMs || validUntil <= validFrom) {
    blockers.push('mandate-not-currently-valid')
  }

  if (mandate.executionMode !== 'per-transfer') {
    blockers.push('standing-provider-authorization-not-supported-by-nonproduction-evaluator')
  }
  if (evidence.providerAccountIdentityVerified !== true) blockers.push('provider-account-identity-unverified')
  if (evidence.providerSignerPolicyVerified !== true) blockers.push('provider-signer-policy-unverified')
  if (evidence.sponsorFundingVerified !== true) blockers.push('sponsor-principal-and-fee-funding-unverified')
  if (evidence.mainnetSandboxIsolationVerified !== true) blockers.push('sandbox-mainnet-isolation-unverified')

  const uniqueBlockers = [...new Set(blockers)]
  return {
    eligibleForNonProductionReview: uniqueBlockers.length === 0,
    status: uniqueBlockers.length === 0 ? 'nonproduction-preflight-passed-not-authorized' : 'blocked',
    blockers: uniqueBlockers,
    payoutAuthorized: false,
    signerOperationPerformed: false,
    providerRequestPerformed: false,
    transactionBroadcast: false,
    note: 'This pure evaluator is not connected to any runtime payout route. Passing it does not authorize spending, signing, provider submission, or broadcast.',
  }
}
