const REQUIRED_EVIDENCE = Object.freeze([
  'businessAccountOwnershipVerified',
  'liveUsdtTrc20ProductEnabled',
  'beneficiaryPayoutMandateVerified',
  'providerLiquidityOrCreditVerified',
  'ownerApprovalBoundToRequest',
])

/**
 * Fail-closed policy for any future live payout submission.
 *
 * This helper deliberately accepts evidence objects rather than environment
 * booleans. A caller must supply independently retrieved provider/mandate/
 * funding evidence and a request-bound owner approval. It does not fetch,
 * manufacture, or infer those facts and is not a substitute for provider APIs.
 */
export function evaluateFincraLivePayoutGate(evidence = {}) {
  const missing = REQUIRED_EVIDENCE.filter((key) => {
    const item = evidence[key]
    return !item || item.verified !== true
      || typeof item.evidenceReference !== 'string'
      || item.evidenceReference.trim().length < 8
  })

  const liveModeVerified = evidence.environment === 'live'
  if (!liveModeVerified) missing.unshift('liveEnvironmentVerified')

  const requestBindingVerified = evidence.ownerApproval?.requestBindingVerified === true
    && typeof evidence.ownerApproval?.requestDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(evidence.ownerApproval.requestDigest)
  if (!requestBindingVerified && !missing.includes('ownerApprovalBoundToRequest')) {
    missing.push('ownerApprovalBoundToRequest')
  }

  const uniqueMissing = [...new Set(missing)]
  return Object.freeze({
    evidenceComplete: uniqueMissing.length === 0,
    submissionAllowed: false,
    missing: uniqueMissing,
    payoutSubmissionEnabled: false,
    reason: uniqueMissing.length === 0
      ? 'evidence-complete-but-live-submission-requires-separate-reviewed-enablement'
      : 'live-payout-evidence-incomplete',
  })
}

export const FINCRA_LIVE_PAYOUT_REQUIRED_EVIDENCE = REQUIRED_EVIDENCE
