/**
 * Sponsor signer release gate.
 *
 * The resource ledger adapter is implemented and covered by tests, but enabling
 * signing/broadcast still requires an explicit, separately reviewed testnet-pilot
 * approval. This is deliberately not a Mainnet release flag.
 */
export const SPONSOR_RESOURCE_SETTLEMENT_ADAPTER_IMPLEMENTED = true

export function getSponsorFeeBudgetSettlementGate(env = process.env) {
  const pilotApproved = env.SPONSOR_TESTNET_PILOT_RELEASE_APPROVED === 'true'
  const testnetBroadcastOptIn = env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED === 'true'
  const blockers = []
  if (!SPONSOR_RESOURCE_SETTLEMENT_ADAPTER_IMPLEMENTED) blockers.push('resource-settlement-adapter-not-implemented')
  if (!pilotApproved) blockers.push('independent-testnet-pilot-release-approval-required')
  if (!testnetBroadcastOptIn) blockers.push('testnet-signed-broadcast-flag-disabled')
  return {
    ready: blockers.length === 0,
    resourceSettlementAdapterImplemented: SPONSOR_RESOURCE_SETTLEMENT_ADAPTER_IMPLEMENTED,
    pilotApproved,
    testnetBroadcastOptIn,
    blockers,
    reason: blockers[0] || null,
    mainnetSubmissionSupported: false,
    userFundedFallbackAllowed: false,
  }
}
