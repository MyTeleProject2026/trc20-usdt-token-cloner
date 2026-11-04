/**
 * Hard release gate for testnet sponsor signing and broadcast.
 *
 * Resource mandates, reservations, conditional receipt settlement, local
 * cryptographic block/transaction integrity checks, and conservative two-provider
 * DPoS finality cross-checks are implemented. The gate remains closed until those
 * implementations receive independent protocol/security review, the remaining
 * stake-changing contract surface is reviewed, production database restore is
 * rehearsed, funded testnet E2E is observed, and sponsor approvals are verified.
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
          'historical-delegation-cryptographic-proof-implementation-not-independently-reviewed',
          'historical-delegation-witness-state-and-canonical-chain-not-independently-witnessed',
          'stake-changing-contract-coverage-not-independently-reviewed',
          'fee-to-principal-resource-delegation-transactions-not-independently-audited',
          'production-database-migration-and-restore-rehearsal-not-complete',
          'funded-nile-and-shasta-sponsored-transfer-not-verified',
          'independent-sponsor-security-review-required',
          'sponsor-authorization-and-provider-configuration-not-independently-verified',
        ],
  }
}
