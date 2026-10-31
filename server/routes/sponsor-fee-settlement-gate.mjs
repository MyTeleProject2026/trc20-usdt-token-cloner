/**
 * Hard release gate for testnet sponsor signing and broadcast.
 *
 * Resource budgets and receipt observations are now persisted, but the code
 * still cannot independently attribute actual Energy/Bandwidth consumption
 * to the exact fee sponsor and settle/release the approved budget from that
 * proof. Keep this hard gate closed until that adapter and E2E tests exist.
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
