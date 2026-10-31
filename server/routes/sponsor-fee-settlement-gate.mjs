/**
 * Hard release gate for testnet sponsor signing and broadcast.
 *
 * Resource mandates, reservations and conditional receipt settlement are now
 * implemented. The gate remains closed because historical delegation state at
 * the transfer block, dedicated DB integration coverage, funded testnet E2E and
 * independent sponsor/security approvals are not yet verified.
 */
const SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY = false

export function getSponsorFeeBudgetSettlementGate() {
  return {
    ready: SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY,
    reason: SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY
      ? null
      : 'sponsor-release-evidence-and-acceptance-gates-incomplete',
    blockers: SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY
      ? []
      : [
          'historical-delegation-state-at-transfer-block-not-independently-proven',
          'resource-settlement-database-integration-tests-not-complete',
          'funded-nile-and-shasta-sponsored-transfer-not-verified',
          'independent-sponsor-security-review-required',
          'sponsor-authorization-and-provider-configuration-not-independently-verified',
        ],
  }
}
