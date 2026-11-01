/**
 * Hard source-controlled release gate for sponsor-paid testnet network fees.
 *
 * The existing sponsor path can check point-in-time resource capacity, but the
 * resource budget reservation and transaction-specific solidified settlement
 * adapter is not integrated on main yet. Runtime variables must never stand in
 * for that code or for an independently approved pilot.
 *
 * Change the constant only in a reviewed implementation that integrates the
 * resource ledger and its PostgreSQL/concurrency/reconciliation tests. The
 * separate pilot approval remains required after that implementation lands.
 */
export const SPONSOR_FEE_RESOURCE_SETTLEMENT_ADAPTER_IMPLEMENTED = false

export function getSponsorFeeResourceSettlementGate(env = process.env) {
  const testnetPilotReleaseApproved = env.SPONSOR_TESTNET_PILOT_RELEASE_APPROVED === 'true'
  const blockers = []
  if (!SPONSOR_FEE_RESOURCE_SETTLEMENT_ADAPTER_IMPLEMENTED) {
    blockers.push('fee-sponsor-resource-settlement-adapter-not-integrated')
  }
  if (!testnetPilotReleaseApproved) {
    blockers.push('independent-controlled-testnet-pilot-approval-required')
  }
  return {
    ready: blockers.length === 0,
    resourceSettlementAdapterImplemented: SPONSOR_FEE_RESOURCE_SETTLEMENT_ADAPTER_IMPLEMENTED,
    testnetPilotReleaseApproved,
    blockers,
    reason: blockers[0] || null,
    mainnetSubmissionSupported: false,
    userFundedFallbackAllowed: false,
  }
}
