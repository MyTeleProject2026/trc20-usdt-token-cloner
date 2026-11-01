/**
 * Hard release gate for testnet sponsor signing and broadcast.
 *
 * Resource mandates, reservations, conditional receipt settlement and a
 * two-provider solidified block-history cross-check are implemented. The gate remains
 * closed because cryptographic/independent block and transaction-inclusion proof,
 * protocol-wide stake-change review, production database migration/restore,
 * funded testnet E2E, and sponsor/security approvals remain outstanding.
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
          'historical-delegation-block-and-transaction-inclusion-not-independently-verified',
          'stake-changing-contract-coverage-not-independently-reviewed',
          'fee-to-principal-resource-delegation-transactions-not-independently-audited',
          'production-database-migration-and-restore-rehearsal-not-complete',
          'funded-nile-and-shasta-sponsored-transfer-not-verified',
          'independent-sponsor-security-review-required',
          'sponsor-authorization-and-provider-configuration-not-independently-verified',
        ],
  }
}
