const MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const POSITIVE_INTEGER = /^[1-9][0-9]*$/

function positiveBaseUnits(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!POSITIVE_INTEGER.test(raw)) return 0n
  try { return BigInt(raw) } catch { return 0n }
}

/**
 * Fail-closed policy for provider-funded USDT TRC20 payouts.
 *
 * The funding attestation must come from an authenticated provider adapter,
 * never from a browser request, owner-entered balance, or environment toggle.
 * A provider-funded balance or an expressly approved credit facility can
 * cover principal; fee coverage and an installed broadcast adapter are
 * separately required before execution can be enabled.
 */
export function evaluateProviderPayoutReadiness(input = {}) {
  const providerName = typeof input.providerName === 'string' ? input.providerName.trim().slice(0, 80) : ''
  const sourceType = input.sourceType === 'provider-owned-liquidity'
    || input.sourceType === 'provider-approved-credit' ? input.sourceType : 'none'
  const availablePrincipalBaseUnits = positiveBaseUnits(input.availablePrincipalBaseUnits)
  const creditLimitBaseUnits = positiveBaseUnits(input.creditLimitBaseUnits)
  const principalFundingVerified = sourceType === 'provider-owned-liquidity'
    ? availablePrincipalBaseUnits > 0n
    : sourceType === 'provider-approved-credit'
      ? input.creditFacilityApproved === true && creditLimitBaseUnits > 0n
      : false

  const checks = {
    providerSelected: Boolean(providerName),
    providerAuthorizationVerified: input.providerAuthorizationVerified === true,
    payoutApiAuthenticated: input.payoutApiAuthenticated === true,
    mainnetUsdtTrc20Supported: input.mainnetUsdtTrc20Supported === true,
    livePayoutsEnabled: input.livePayoutsEnabled === true,
    principalFundingVerified,
    networkFeeCoverageVerified: input.networkFeeCoverageVerified === true,
    broadcastAdapterReady: input.broadcastAdapterReady === true,
  }
  const blockers = []
  if (!checks.providerSelected) blockers.push('no-provider-selected')
  if (!checks.providerAuthorizationVerified) blockers.push('provider-authorization-not-verified')
  if (!checks.payoutApiAuthenticated) blockers.push('provider-api-authentication-not-verified')
  if (!checks.mainnetUsdtTrc20Supported) blockers.push('provider-usdt-tron-mainnet-support-not-verified')
  if (!checks.livePayoutsEnabled) blockers.push('provider-live-payouts-not-enabled')
  if (!checks.principalFundingVerified) blockers.push('provider-owned-liquidity-or-approved-credit-not-verified')
  if (!checks.networkFeeCoverageVerified) blockers.push('network-fee-coverage-not-verified')
  if (!checks.broadcastAdapterReady) blockers.push('approved-provider-broadcast-adapter-not-installed')

  return {
    platformMode: 'private-owner-only',
    network: 'TRON Mainnet',
    asset: 'USDT TRC20',
    tokenContract: MAINNET_USDT_CONTRACT,
    provider: providerName ? { name: providerName, selected: true } : { name: null, selected: false },
    sourceType,
    availablePrincipalBaseUnits: availablePrincipalBaseUnits.toString(),
    creditLimitBaseUnits: creditLimitBaseUnits.toString(),
    checks,
    blockers,
    executionEnabled: blockers.length === 0,
    status: blockers.length === 0 ? 'provider-payout-ready' : 'provider-payout-blocked',
  }
}

export function getUnconfiguredProviderPayoutReadiness() {
  return evaluateProviderPayoutReadiness()
}
