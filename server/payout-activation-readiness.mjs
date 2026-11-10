const REQUIRED_EVIDENCE = Object.freeze([
  ['providerAuthorizationVerified', 'provider-payout-authorization-not-verified'],
  ['providerWalletIdentityVerified', 'provider-wallet-identity-not-verified'],
  ['walletSpecificAvailableUsdtVerified', 'wallet-specific-available-usdt-not-verified'],
  ['availableUsdtCoversRequestedAmount', 'available-usdt-does-not-cover-request'],
  ['tronMainnetUsdtContractVerified', 'tron-mainnet-usdt-contract-not-verified'],
  ['tronMainnetGasAvailable', 'tron-mainnet-gas-not-verified'],
  ['recipientScreeningCleared', 'recipient-kyt-screening-not-cleared'],
  ['withdrawalApprovalSatisfied', 'withdrawal-approval-not-satisfied'],
  ['settlementReconciliationReady', 'settlement-reconciliation-not-ready'],
])

export function evaluatePayoutActivationReadiness(evidence = {}, { amountUsdt } = {}) {
  const blockers = []
  // USDT has six decimals. BigInt base-unit comparison avoids floating-point
  // rounding at the 1,000 USDT policy boundary, including very large inputs.
  const validAmount = typeof amountUsdt === 'string'
    && /^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amountUsdt)
  const [whole = '', fraction = ''] = validAmount ? amountUsdt.split('.') : []
  const amountBaseUnits = validAmount
    ? BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
    : null
  if (amountBaseUnits === null || amountBaseUnits < 1_000_000_000n) {
    blockers.push('minimum-withdrawal-1000-usdt-not-met')
  }
  for (const [field, reason] of REQUIRED_EVIDENCE) {
    if (evidence[field] !== true) blockers.push(reason)
  }
  // Credit approval is distinct from wallet liquidity; neither is inferred
  // from plan limits, displayed USD value, or aggregate workspace balances.
  const providerOwnedLiquidityReady = evidence.providerOwnedLiquidityVerified === true
    && typeof evidence.providerLiquidityEvidenceReference === 'string'
    && evidence.providerLiquidityEvidenceReference.trim().length >= 8
  const creditExpiry = typeof evidence.creditFacilityValidUntil === 'string'
    ? Date.parse(evidence.creditFacilityValidUntil) : NaN
  const creditLimit = typeof evidence.creditFacilityApprovedLimitUsdt === 'string'
    && /^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(evidence.creditFacilityApprovedLimitUsdt)
    ? (() => { const [w, f = ''] = evidence.creditFacilityApprovedLimitUsdt.split('.'); return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6)) })()
    : null
  const approvedCreditUseReady = evidence.creditFacilityApproved === true
    && evidence.creditFacilityUsePermittedForTronUsdtWithdrawals === true
    && typeof evidence.creditFacilityApprovalReference === 'string'
    && evidence.creditFacilityApprovalReference.trim().length >= 8
    && typeof evidence.creditFacilityUseAuthorizationReference === 'string'
    && evidence.creditFacilityUseAuthorizationReference.trim().length >= 8
    && Number.isFinite(creditExpiry) && creditExpiry > Date.now()
    && creditLimit !== null && amountBaseUnits !== null && creditLimit >= amountBaseUnits
  if (!providerOwnedLiquidityReady && !approvedCreditUseReady) {
    blockers.push('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available')
  }
  return Object.freeze({
    schema: 'tron-transfer.payout-activation-readiness.v1',
    status: blockers.length ? 'payout-activation-blocked' : 'payout-activation-ready-for-authorized-operator-review',
    blockers: Object.freeze([...new Set(blockers)]),
    minimumWithdrawalUsdt: '1000',
    amountUsdt: validAmount ? amountUsdt : null,
    executionEnabled: false,
    signingEnabled: false,
    broadcastingEnabled: false,
    transactionSubmitted: false,
  })
}
