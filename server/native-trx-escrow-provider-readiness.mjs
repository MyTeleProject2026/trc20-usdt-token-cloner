const POSITIVE_INTEGER = /^[1-9][0-9]*$/

function positiveSun(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!POSITIVE_INTEGER.test(raw)) return 0n
  try { return BigInt(raw) } catch { return 0n }
}

/**
 * Fail-closed readiness policy for provider-funded native TRX escrow deposits.
 * Inputs must be populated by a server-side authenticated provider adapter and
 * independently verified agreement data, never by a browser request.
 */
export function evaluateNativeTrxEscrowReadiness(input = {}) {
  const providerName = typeof input.providerName === 'string' ? input.providerName.trim().slice(0, 80) : ''
  const sourceType = input.sourceType === 'provider-owned-liquidity' || input.sourceType === 'provider-approved-credit'
    ? input.sourceType : 'none'
  const availablePrincipalSun = positiveSun(input.availablePrincipalSun)
  const approvedCreditLimitSun = positiveSun(input.approvedCreditLimitSun)
  const principalVerified = sourceType === 'provider-owned-liquidity'
    ? availablePrincipalSun > 0n && input.providerWalletOwnershipVerified === true
    : sourceType === 'provider-approved-credit'
      ? input.creditFacilityApproved === true && approvedCreditLimitSun > 0n
      : false
  const checks = {
    providerSelected: Boolean(providerName),
    providerAuthorizationVerified: input.providerAuthorizationVerified === true,
    providerApiAuthenticated: input.providerApiAuthenticated === true,
    tronMainnetNativeTrxSupported: input.tronMainnetNativeTrxSupported === true,
    principalFundingVerified: principalVerified,
    feeCoverageVerified: input.feeCoverageVerified === true,
    payableEscrowCallSupported: input.payableEscrowCallSupported === true,
    destinationAndPurposeAuthorized: input.destinationAndPurposeAuthorized === true,
    limitsAndComplianceApproved: input.limitsAndComplianceApproved === true,
    livePayoutsApproved: input.livePayoutsApproved === true,
  }
  const blockers = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key + '-not-verified')
  return {
    platformMode: 'private-owner-only',
    network: 'TRON Mainnet',
    asset: 'TRX',
    provider: providerName || null,
    sourceType,
    availablePrincipalSun: availablePrincipalSun.toString(),
    approvedCreditLimitSun: approvedCreditLimitSun.toString(),
    checks,
    blockers,
    executionEnabled: blockers.length === 0,
    status: blockers.length === 0 ? 'native-trx-provider-ready' : 'native-trx-provider-blocked',
  }
}

export function getUnconfiguredNativeTrxEscrowReadiness() {
  return evaluateNativeTrxEscrowReadiness()
}
