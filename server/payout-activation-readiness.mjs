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
  const amount = typeof amountUsdt === 'string' && /^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amountUsdt)
    ? Number(amountUsdt) : NaN
  if (!Number.isFinite(amount) || amount < 1000) blockers.push('minimum-withdrawal-1000-usdt-not-met')
  for (const [field, reason] of REQUIRED_EVIDENCE) {
    if (evidence[field] !== true) blockers.push(reason)
  }
  // Either verified spendable provider funds or an explicitly approved credit
  // facility must cover the request. A credit facility is not inferred from a plan limit.
  if (evidence.providerOwnedLiquidityVerified !== true && evidence.creditFacilityApproved !== true) {
    blockers.push('neither-provider-owned-liquidity-nor-approved-credit-is-available')
  }
  return Object.freeze({
    schema: 'tron-transfer.payout-activation-readiness.v1',
    status: blockers.length ? 'payout-activation-blocked' : 'payout-activation-ready-for-authorized-operator-review',
    blockers: Object.freeze([...new Set(blockers)]),
    minimumWithdrawalUsdt: '1000',
    amountUsdt: Number.isFinite(amount) ? String(amountUsdt) : null,
    executionEnabled: false,
    signingEnabled: false,
    broadcastingEnabled: false,
    transactionSubmitted: false,
  })
}
