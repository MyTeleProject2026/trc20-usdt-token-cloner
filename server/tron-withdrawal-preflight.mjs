import { assessFystackWalletUsdtLiquidity } from './fystack-wallet-liquidity-assessment.mjs'
import { evaluatePayoutActivationReadiness } from './payout-activation-readiness.mjs'

/**
 * Composes provider wallet observations and TRON resource observations for UI
 * preflight only. It never reserves funds, authorizes credit, signs, or broadcasts.
 */
export function assessTronWithdrawalPreflight({
  amountUsdt,
  walletSnapshot,
  expectedWalletId,
  expectedWalletAddress,
  tronResourceSnapshot,
  recipientAddressValid = false,
  recipientNetworkConfirmed = false,
  screeningCleared = false,
  approvalSatisfied = false,
} = {}) {
  const liquidity = assessFystackWalletUsdtLiquidity(walletSnapshot, {
    amountUsdt, expectedWalletId, expectedWalletAddress,
  })
  const resource = tronResourceSnapshot?.network === 'TRON_MAINNET'
    && tronResourceSnapshot?.address === expectedWalletAddress
    && typeof tronResourceSnapshot?.checkedAt === 'string'
    && Number.isFinite(Date.parse(tronResourceSnapshot.checkedAt))
    && Date.parse(tronResourceSnapshot.checkedAt) <= Date.now()
    && Date.now() - Date.parse(tronResourceSnapshot.checkedAt) <= 120000
    && ['energyAvailable', 'bandwidthAvailable', 'trxBalanceSun'].every((key) =>
      typeof tronResourceSnapshot[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(tronResourceSnapshot[key]))
  const blockers = [...liquidity.blockers]
  if (!resource) blockers.push('tron-mainnet-resource-snapshot-missing-stale-or-invalid')
  if (recipientAddressValid !== true) blockers.push('recipient-address-not-validated')
  if (recipientNetworkConfirmed !== true) blockers.push('recipient-network-not-confirmed-as-tron-mainnet-trc20')
  if (screeningCleared !== true) blockers.push('recipient-screening-not-cleared')
  if (approvalSatisfied !== true) blockers.push('withdrawal-approval-not-satisfied')
  // The resource snapshot is observational. Actual fee sufficiency depends on
  // transaction simulation and any provider-sponsored resource authorization.
  const readiness = evaluatePayoutActivationReadiness({}, { amountUsdt })
  return Object.freeze({
    schema: 'tron-transfer.withdrawal-preflight.v1',
    status: blockers.length || readiness.blockers.length
      ? 'withdrawal-preflight-blocked' : 'withdrawal-preflight-observations-complete-review-required',
    blockers: Object.freeze([...new Set([...blockers, ...readiness.blockers])]),
    liquidity,
    tronResources: Object.freeze({
      observed: resource,
      energyAvailable: resource ? tronResourceSnapshot.energyAvailable : null,
      bandwidthAvailable: resource ? tronResourceSnapshot.bandwidthAvailable : null,
      trxBalanceSun: resource ? tronResourceSnapshot.trxBalanceSun : null,
      feeSufficiencyVerified: false,
    }),
    recipient: Object.freeze({
      addressValid: recipientAddressValid === true,
      tronMainnetTrc20Confirmed: recipientNetworkConfirmed === true,
      screeningCleared: screeningCleared === true,
      approvalSatisfied: approvalSatisfied === true,
    }),
    reservationCreated: false,
    settlementVerified: false,
    payoutAuthorized: false,
    signingEnabled: false,
    broadcastingEnabled: false,
    executionEnabled: false,
  })
}
