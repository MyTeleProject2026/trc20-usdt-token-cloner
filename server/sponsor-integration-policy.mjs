const NETWORKS = new Set(['mainnet', 'shasta', 'nile'])
const MODELS = new Set(['third-party-provider', 'sponsor-organization'])
const UINT256_MAX = (1n << 256n) - 1n

function positiveUint256(value) {
  if (typeof value !== 'string'
    || value.length > 78
    || !/^[1-9][0-9]*$/.test(value)) return false
  return BigInt(value) <= UINT256_MAX
}

function covered(balance, required) {
  if (!positiveUint256(balance) || !positiveUint256(required)) return false
  return BigInt(balance) >= BigInt(required)
}

/**
 * Pure fail-closed policy evaluator for the dual sponsor model.
 *
 * This function is a preflight gate, not a signer, provider adapter, or submitter.
 * It deliberately requires independently verified evidence supplied by a trusted
 * server-side integration; caller-provided booleans from an HTTP body are not evidence.
 */
export function evaluateSponsorTransferEligibility(evidence = {}) {
  const blockers = []
  const mode = evidence.mode
  const network = evidence.network
  const principal = evidence.principal
  const fee = evidence.fee
  const authorization = evidence.authorization
  const controls = evidence.controls

  if (!MODELS.has(mode)) blockers.push('unsupported-sponsor-model')
  if (!NETWORKS.has(network)) blockers.push('unsupported-network')
  if (controls?.emergencyPause !== false) blockers.push('sponsor-submissions-paused-or-pause-state-unknown')
  if (controls?.operatorApproval !== true) blockers.push('operator-approval-missing')
  if (controls?.destinationAllowed !== true) blockers.push('destination-not-allowlisted')
  if (controls?.assetContractVerified !== true) blockers.push('asset-contract-not-verified')
  if (controls?.quoteFresh !== true) blockers.push('quote-missing-or-expired')
  if (controls?.idempotencyReserved !== true) blockers.push('idempotency-reservation-missing')
  if (controls?.separateBudgetsReserved !== true) blockers.push('separate-principal-and-fee-reservations-missing')
  if (controls?.settlementVerifierReady !== true) blockers.push('independent-settlement-verifier-unavailable')

  if (principal?.consentVerified !== true) blockers.push('asset-sponsor-consent-unverified')
  if (principal?.fundingSnapshotFresh !== true) blockers.push('asset-sponsor-funding-snapshot-not-fresh')
  if (principal?.network !== network) blockers.push('asset-sponsor-network-mismatch')
  if (!covered(principal?.availableBaseUnits, principal?.requiredBaseUnits)) {
    blockers.push('asset-principal-funding-insufficient-or-unverified')
  }

  if (fee?.consentVerified !== true) blockers.push('fee-sponsor-consent-unverified')
  if (fee?.fundingSnapshotFresh !== true) blockers.push('fee-sponsor-funding-snapshot-not-fresh')
  if (fee?.network !== network) blockers.push('fee-sponsor-network-mismatch')
  if (fee?.coverageVerified !== true
    || !covered(fee?.availableBaseUnits, fee?.requiredBaseUnits)) {
    blockers.push('network-fee-coverage-insufficient-or-unverified')
  }

  if (typeof principal?.sponsorId !== 'string' || !principal.sponsorId.trim()) blockers.push('asset-sponsor-identity-missing')
  if (typeof fee?.sponsorId !== 'string' || !fee.sponsorId.trim()) blockers.push('fee-sponsor-identity-missing')
  if (typeof authorization?.verifiedIntentDigest !== 'string'
    || !/^[a-f0-9]{64}$/i.test(authorization.verifiedIntentDigest)) blockers.push('cryptographic-intent-authorization-unverified')
  if (authorization?.unexpired !== true) blockers.push('authorization-expired-or-unknown')
  if (authorization?.nonceUnused !== true) blockers.push('authorization-nonce-replayed-or-unknown')

  if (mode === 'third-party-provider' && evidence.provider?.adapterVerified !== true) {
    blockers.push('third-party-provider-adapter-unverified')
  }
  if (mode === 'third-party-provider' && evidence.provider?.accountVerified !== true) {
    blockers.push('third-party-provider-account-unverified')
  }
  if (mode === 'sponsor-organization' && evidence.organization?.identityVerified !== true) {
    blockers.push('sponsor-organization-identity-unverified')
  }
  if (mode === 'sponsor-organization' && evidence.organization?.mandateVerified !== true) {
    blockers.push('sponsor-organization-spending-mandate-unverified')
  }

  const uniqueBlockers = [...new Set(blockers)]
  return {
    eligible: uniqueBlockers.length === 0,
    status: uniqueBlockers.length === 0 ? 'preflight-eligible-not-submitted' : 'blocked',
    mode: MODELS.has(mode) ? mode : null,
    network: NETWORKS.has(network) ? network : null,
    blockers: uniqueBlockers,
    userFundedFallbackAllowed: false,
    submissionPerformed: false,
    note: 'Eligibility is not a transfer, signature, broadcast, or settlement claim. A separate audited submit path must revalidate this evidence and independently verify solidified chain settlement.',
  }
}
