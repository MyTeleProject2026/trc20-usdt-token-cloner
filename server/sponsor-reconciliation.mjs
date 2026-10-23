const NETWORKS = new Set(['mainnet', 'shasta', 'nile'])
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/

function parseBaseUnits(value) {
  if (typeof value !== 'string' || !BASE_UNITS.test(value)) return null
  return BigInt(value)
}

/**
 * Pure read-only reconciliation of actual chain balances against sponsor ledger
 * commitments. This never changes budget rows or approves/submits transactions.
 */
export function reconcileSponsorBudgets({ network, fundingSnapshot, budgets } = {}) {
  const fail = (reason, extra = {}) => ({
    success: false,
    status: reason,
    reason,
    groups: [],
    ...extra,
  })
  if (typeof network !== 'string' || !NETWORKS.has(network)) {
    return fail('invalid-network')
  }
  if (!fundingSnapshot || fundingSnapshot.status !== 'solidified-sponsor-balances-read'
    || fundingSnapshot.onChainBalanceRead !== true
    || fundingSnapshot.cache?.status !== 'fresh'
    || fundingSnapshot.network !== network
    || typeof fundingSnapshot.sponsorAddress !== 'string'
    || !ADDRESS.test(fundingSnapshot.sponsorAddress)
    || typeof fundingSnapshot.checkedAt !== 'string'
    || fundingSnapshot.source !== 'Tatum TRON SolidityNode account and constant-contract queries') {
    return fail('fresh-solidified-funding-snapshot-required')
  }
  const checkedAtMs = Date.parse(fundingSnapshot.checkedAt)
  const ageMs = Date.now() - checkedAtMs
  if (!Number.isFinite(checkedAtMs) || ageMs < -5_000 || ageMs > 15_000) {
    return fail('funding-snapshot-stale')
  }
  if (!Array.isArray(budgets)) return fail('invalid-budget-list')

  const matching = []
  let walletMismatchCount = 0
  for (const budget of budgets) {
    if (!budget || typeof budget !== 'object'
      || budget.network !== network
      || typeof budget.sponsor_address !== 'string'
      || budget.sponsor_address !== fundingSnapshot.sponsorAddress) {
      walletMismatchCount += 1
      continue
    }
    if (!['TRX', 'USDT', 'VTRC'].includes(budget.asset)
      || !['active', 'paused', 'pending-review', 'disabled', 'depleted'].includes(budget.status)
      || (budget.asset === 'TRX' ? budget.token_contract != null
        : typeof budget.token_contract !== 'string' || !ADDRESS.test(budget.token_contract))) {
      return fail('invalid-budget-ledger-record', { walletMismatchCount })
    }
    const total = parseBaseUnits(budget.budget_base_units)
    const reserved = parseBaseUnits(budget.reserved_base_units)
    const spent = parseBaseUnits(budget.spent_base_units)
    if (total === null || reserved === null || spent === null || reserved + spent > total) {
      return fail('invalid-budget-ledger-record', { walletMismatchCount })
    }
    matching.push({ ...budget, _total: total, _reserved: reserved, _spent: spent })
  }

  const grouped = new Map()
  for (const budget of matching) {
    const key = JSON.stringify([budget.asset, budget.token_contract || null])
    let item = grouped.get(key)
    if (!item) {
      item = {
        asset: budget.asset,
        tokenContract: budget.token_contract || null,
        budgetCount: 0,
        activeBudgetCount: 0,
        pausedBudgetCount: 0,
        pendingReviewBudgetCount: 0,
        unapprovedActiveBudgetCount: 0,
        committedBaseUnits: 0n,
        unreservedLedgerBaseUnits: 0n,
      }
      grouped.set(key, item)
    }
    item.budgetCount += 1
    if (budget.status === 'active') item.activeBudgetCount += 1
    if (budget.status === 'paused') item.pausedBudgetCount += 1
    if (budget.status === 'pending-review') item.pendingReviewBudgetCount += 1
    if (budget.status === 'active' && budget.approvalScopeVerified !== true) item.unapprovedActiveBudgetCount += 1

    // Active and paused budgets retain their remaining cap; inactive rows only
    // contribute any reservations already held by legacy/in-flight ledger rows.
    item.committedBaseUnits += ['active', 'paused'].includes(budget.status)
      ? budget._total - budget._spent
      : budget._reserved
    item.unreservedLedgerBaseUnits += budget._total - budget._reserved - budget._spent
  }

  const groups = [...grouped.values()].map((item) => {
    let balance = null
    let balanceStatus = 'unavailable'
    if (item.asset === 'TRX') {
      const raw = fundingSnapshot.native?.balanceSun
      if (fundingSnapshot.native?.status === 'verified') {
        balance = parseBaseUnits(raw)
      }
    } else {
      const displayAsset = item.asset === 'USDT' && network !== 'mainnet'
        ? 'USDT (testnet)' : item.asset
      const token = Array.isArray(fundingSnapshot.tokens)
        ? fundingSnapshot.tokens.find((entry) => entry?.asset === displayAsset
          && entry?.tokenContract === item.tokenContract
          && entry?.status === 'verified')
        : null
      if (token) balance = parseBaseUnits(token.balanceBaseUnits)
      if (item.asset === 'USDT' && network === 'mainnet'
        && item.tokenContract !== 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') {
        balance = null
      }
      if (item.asset === 'USDT' && network === 'mainnet') {
        const token = fundingSnapshot.tokens?.find((entry) => entry?.tokenContract === item.tokenContract && entry?.asset === 'USDT')
        if (token?.decimals !== 6) balance = null
      }
    }
    if (balance !== null) balanceStatus = 'verified'
    const required = item.committedBaseUnits
    const status = balance === null ? 'balance-unavailable'
      : balance < required ? 'underfunded' : 'covered'
    return {
      asset: item.asset,
      tokenContract: item.tokenContract,
      budgetCount: item.budgetCount,
      activeBudgetCount: item.activeBudgetCount,
      pausedBudgetCount: item.pausedBudgetCount,
      pendingReviewBudgetCount: item.pendingReviewBudgetCount,
      unapprovedActiveBudgetCount: item.unapprovedActiveBudgetCount,
      committedBaseUnits: required.toString(),
      unreservedLedgerBaseUnits: item.unreservedLedgerBaseUnits.toString(),
      onChainBalanceBaseUnits: balance?.toString() ?? null,
      deficitBaseUnits: balance !== null && balance < required
        ? (required - balance).toString() : '0',
      balanceStatus,
      status,
    }
  })

  const status = walletMismatchCount > 0 ? 'wallet-scope-mismatch'
    : groups.some((group) => group.unapprovedActiveBudgetCount > 0) ? 'approval-required'
      : groups.some((group) => group.status === 'balance-unavailable') ? 'balance-unavailable'
      : groups.some((group) => group.status === 'underfunded') ? 'underfunded'
        : groups.length === 0 ? 'no-sponsor-budgets' : 'covered'
  const covered = status === 'covered'
  return {
    // success means the reconciliation was computed from valid complete inputs.
    // 'covered' separately answers whether every tracked allocation is funded.
    success: walletMismatchCount === 0
      && !groups.some((group) => group.unapprovedActiveBudgetCount > 0)
      && !groups.some((group) => group.status === 'balance-unavailable'),
    covered,
    status,
    network,
    sponsorAddress: fundingSnapshot.sponsorAddress,
    checkedAt: fundingSnapshot.checkedAt,
    snapshotAgeMs: Math.max(0, ageMs),
    budgetCount: matching.length,
    walletMismatchCount,
    groups,
    providerFundingVerified: false,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    note: 'Read-only reconciliation. Chain balances may change after this snapshot. Ledger caps and reservations are accounting records, not proof of sponsor consent, signing authority, or permission to submit. This report does not alter budgets or transactions.',
  }
}

export default reconcileSponsorBudgets
