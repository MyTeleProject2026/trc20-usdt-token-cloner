/**
 * Hard release gate for testnet asset-principal signing/broadcast.
 *
 * The current code can check delegated resource capacity and observe solidified
 * transaction costs, but it does not yet atomically reserve and settle the
 * separate fee-sponsor resource budget for each principal transfer. A route
 * environment flag is not proof that this accounting adapter exists.
 *
 * Keep this capability false until the database transaction links an approved
 * fee-resource budget to each principal reservation, reserves capacity
 * transactionally, and settles/releases it only from independently verified
 * transaction-specific resource-consumption evidence. Tests must cover retries,
 * concurrency, failures, and reconciliation drift before changing this constant.
 */
const SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY = false

export function getSponsorFeeBudgetSettlementGate() {
  return {
    ready: SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY,
    reason: SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY
      ? null
      : 'fee-sponsor-budget-settlement-not-integrated',
    blockers: SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY
      ? []
      : [
          'atomic-fee-resource-budget-reservation-not-integrated',
          'transaction-specific-fee-sponsor-resource-cost-attribution-not-verified',
          'solidified-fee-resource-budget-settlement-and-release-not-integrated',
        ],
  }
}
