/**
 * Hard release gate for testnet sponsor signing and broadcast.
 *
 * Resource mandates, reservations, conditional receipt settlement and isolated
 * PostgreSQL regression/concurrency coverage are implemented. The gate remains
 * closed because historical delegation state at the transfer block, a production
 * database migration/restore rehearsal, funded testnet E2E, and independent
 * sponsor/security approvals are not yet verified.
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
          'production-database-migration-and-restore-rehearsal-not-complete',
          'funded-nile-and-shasta-sponsored-transfer-not-verified',
          'independent-sponsor-security-review-required',
          'sponsor-authorization-and-provider-configuration-not-independently-verified',
        ],
  }
}
