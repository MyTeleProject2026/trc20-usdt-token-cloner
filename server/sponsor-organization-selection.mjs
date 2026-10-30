import { createSponsorRoleFundingReader } from './sponsor-roles.mjs'
import { reconcileSponsorBudgets } from './sponsor-reconciliation.mjs'
import { isValidTronAddress } from './tron-address.mjs'

const NETWORKS = new Set(['mainnet', 'nile', 'shasta'])
const ASSETS = new Set(['TRX', 'USDT'])
const UINT_PATTERN = /^[1-9][0-9]{0,77}$/
const MAX_PAIRS_TO_READ = 10

function scopedRoleEnvironment(env, network, feeAddress, principalAddress) {
  const feeKey = `SPONSOR_FEE_${network.toUpperCase()}_ADDRESS`
  const principalKey = `SPONSOR_ASSET_${network.toUpperCase()}_ADDRESS`
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === feeKey) return feeAddress
      if (property === principalKey) return principalAddress
      return Reflect.get(target, property, receiver)
    },
  })
}

function freshFundingSnapshot(snapshot, network, address) {
  const ageMs = Date.now() - Date.parse(snapshot?.checkedAt || '')
  return snapshot?.status === 'solidified-sponsor-balances-read'
    && snapshot.onChainBalanceRead === true
    && snapshot.network === network
    && snapshot.sponsorAddress === address
    && snapshot.source === 'Tatum TRON SolidityNode account and constant-contract queries'
    && snapshot.cache?.status === 'fresh'
    && Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= 15_000
}

function coveredGroup(reconciliation, asset, tokenContract = null) {
  if (!reconciliation?.success || reconciliation.walletMismatchCount !== 0) return null
  return reconciliation.groups?.find((group) =>
    group.asset === asset
      && (group.tokenContract || null) === tokenContract
      && group.status === 'covered'
      && group.unapprovedActiveBudgetCount === 0,
  ) || null
}

function sortCandidates(candidates, required) {
  return candidates
    .filter((candidate) => {
      try { return BigInt(candidate.availableLedgerBaseUnits) >= BigInt(required) } catch { return false }
    })
    .sort((a, b) => {
      const left = BigInt(a.availableLedgerBaseUnits) - BigInt(required)
      const right = BigInt(b.availableLedgerBaseUnits) - BigInt(required)
      return left < right ? -1 : left > right ? 1
        : String(a.budgetId).localeCompare(String(b.budgetId), 'en', { numeric: true })
    })
}

function candidateIdentity(candidate) {
  return {
    organizationId: candidate.organizationId,
    organizationReference: candidate.organizationReference,
    organizationName: candidate.organizationName,
    accountId: candidate.accountId,
    sponsorReference: candidate.sponsorReference,
    sponsorAddress: candidate.sponsorAddress,
    budgetId: candidate.budgetId,
    availableLedgerBaseUnits: candidate.availableLedgerBaseUnits,
  }
}

/**
 * Read-only dual-sponsor preflight. It uses registered and linked accounts,
 * checks their independent budget ledgers, obtains fresh role-specific chain
 * snapshots, and requires a current observed fee-to-principal delegation.
 * It does not reserve money, authorize an intent, or submit a transaction.
 */
export async function selectSponsorOrganizationPair({
  store,
  env = process.env,
  network,
  asset,
  tokenContract = null,
  amountBaseUnits,
  estimatedFeeSun,
  readRoleFunding,
} = {}) {
  const fail = (reason, extra = {}) => ({
    success: false,
    status: reason,
    reason,
    selection: null,
    evaluatedPairs: 0,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    transactionSubmitted: false,
    userFundedFallbackAllowed: false,
    ...extra,
  })
  if (!store || typeof store.listBudgetLinks !== 'function'
    || typeof store.listBudgetsForWallet !== 'function') return fail('sponsor-registry-store-unavailable')
  if (!NETWORKS.has(network) || !ASSETS.has(asset)
    || !UINT_PATTERN.test(amountBaseUnits || '')
    || !UINT_PATTERN.test(estimatedFeeSun || '')
    || (asset === 'TRX' ? tokenContract !== null : typeof tokenContract !== 'string'
      || !isValidTronAddress(tokenContract))) {
    return fail('invalid-sponsor-selection-request')
  }

  let linksResult
  try {
    linksResult = await store.listBudgetLinks({ network, limit: 100 })
  } catch {
    return fail('sponsor-budget-link-ledger-unavailable')
  }
  if (!linksResult?.success) return fail(linksResult?.reason || 'sponsor-budget-link-ledger-unavailable')
  if (!Array.isArray(linksResult.links) || linksResult.links.length >= 100) {
    return fail('sponsor-budget-link-ledger-truncated')
  }

  const principalCandidates = sortCandidates(linksResult.links.filter((link) =>
    link.linkCurrentlyActive === true
      && link.linkStatus === 'active'
      && link.organizationStatus === 'approved'
      && link.accountStatus === 'verified'
      && link.network === network
      && link.role === 'asset-principal'
      && link.purpose === 'asset-grant'
      && link.asset === asset
      && (link.tokenContract || null) === tokenContract
      && link.agreementScopeVerified === true
      && link.budgetStatus === 'active',
  ), amountBaseUnits)

  const feeCandidates = sortCandidates(linksResult.links.filter((link) =>
    link.linkCurrentlyActive === true
      && link.linkStatus === 'active'
      && link.organizationStatus === 'approved'
      && link.accountStatus === 'verified'
      && link.network === network
      && link.role === 'network-fee'
      && link.purpose === 'network-fee'
      && link.asset === 'TRX'
      && link.tokenContract == null
      && link.agreementScopeVerified === true
      && link.budgetStatus === 'active',
  ), estimatedFeeSun)

  if (!principalCandidates.length) return fail('no-approved-principal-budget-candidate')
  if (!feeCandidates.length) return fail('no-approved-fee-budget-candidate')

  const pairs = []
  for (const principal of principalCandidates) {
    for (const fee of feeCandidates) {
      if (principal.sponsorAddress === fee.sponsorAddress) continue
      pairs.push({ principal, fee })
    }
  }
  pairs.sort((a, b) => {
    const aPrincipalSlack = BigInt(a.principal.availableLedgerBaseUnits) - BigInt(amountBaseUnits)
    const bPrincipalSlack = BigInt(b.principal.availableLedgerBaseUnits) - BigInt(amountBaseUnits)
    if (aPrincipalSlack !== bPrincipalSlack) return aPrincipalSlack < bPrincipalSlack ? -1 : 1
    const aFeeSlack = BigInt(a.fee.availableLedgerBaseUnits) - BigInt(estimatedFeeSun)
    const bFeeSlack = BigInt(b.fee.availableLedgerBaseUnits) - BigInt(estimatedFeeSun)
    if (aFeeSlack !== bFeeSlack) return aFeeSlack < bFeeSlack ? -1 : 1
    return String(a.principal.budgetId).localeCompare(String(b.principal.budgetId), 'en', { numeric: true })
  })
  if (!pairs.length) return fail('principal-and-fee-accounts-must-be-distinct')
  const candidateSearchTruncated = pairs.length > MAX_PAIRS_TO_READ
  const evaluated = pairs.slice(0, MAX_PAIRS_TO_READ)
  const blockers = new Set()
  let evaluatedPairs = 0

  for (const pair of evaluated) {
    evaluatedPairs += 1
    let roleFunding
    try {
      if (typeof readRoleFunding === 'function') {
        roleFunding = await readRoleFunding(network, pair.fee.sponsorAddress, pair.principal.sponsorAddress)
      } else {
        const roleEnv = scopedRoleEnvironment(env, network, pair.fee.sponsorAddress, pair.principal.sponsorAddress)
        const reader = createSponsorRoleFundingReader({ env: roleEnv })
        roleFunding = await reader(network, { refresh: true })
      }
    } catch {
      blockers.add('sponsor-role-chain-read-failed')
      continue
    }

    const feeSnapshot = roleFunding?.fundingSnapshots?.networkFeeSponsor
    const principalSnapshot = roleFunding?.fundingSnapshots?.assetPrincipalSponsor
    if (!freshFundingSnapshot(feeSnapshot, network, pair.fee.sponsorAddress)
      || !freshFundingSnapshot(principalSnapshot, network, pair.principal.sponsorAddress)) {
      blockers.add('fresh-role-specific-funding-snapshots-required')
      continue
    }

    let feeBudgets
    let principalBudgets
    try {
      [feeBudgets, principalBudgets] = await Promise.all([
        store.listBudgetsForWallet({ network, sponsorAddress: pair.fee.sponsorAddress, limit: 100 }),
        store.listBudgetsForWallet({ network, sponsorAddress: pair.principal.sponsorAddress, limit: 100 }),
      ])
    } catch {
      blockers.add('sponsor-budget-ledger-unavailable')
      continue
    }
    if (!feeBudgets?.success || !principalBudgets?.success) {
      blockers.add('sponsor-budget-ledger-unavailable-or-truncated')
      continue
    }

    const feeReconciliation = reconcileSponsorBudgets({
      network,
      fundingSnapshot: feeSnapshot,
      budgets: feeBudgets.budgets.filter((budget) => ASSETS.has(budget.asset)),
    })
    const principalReconciliation = reconcileSponsorBudgets({
      network,
      fundingSnapshot: principalSnapshot,
      budgets: principalBudgets.budgets.filter((budget) => ASSETS.has(budget.asset)),
    })
    const feeGroup = coveredGroup(feeReconciliation, 'TRX', null)
    const principalGroup = coveredGroup(principalReconciliation, asset, tokenContract)
    if (!feeGroup || !principalGroup) {
      blockers.add('role-specific-onchain-balance-does-not-cover-existing-commitments')
      continue
    }

    const feeRole = roleFunding?.roles?.networkFeeSponsor
    const delegation = roleFunding?.feeSponsorDelegationToPrincipal
    const delegationActive = delegation?.success === true
      && delegation.status === 'solidified-delegation-state-read'
      && delegation.fromAddress === pair.fee.sponsorAddress
      && delegation.toAddress === pair.principal.sponsorAddress
      && ((/^[1-9][0-9]*$/.test(String(delegation.activeEnergyStakeSun || '0')))
        || (/^[1-9][0-9]*$/.test(String(delegation.activeBandwidthStakeSun || '0'))))
    if (feeRole?.resourceStatus?.resourceRead !== true || !delegationActive) {
      blockers.add('active-fee-to-principal-resource-delegation-not-observed')
      continue
    }

    return {
      success: true,
      status: 'dual-sponsor-preflight-passed-review-required',
      evaluatedPairs,
      selection: {
        network,
        asset,
        tokenContract,
        amountBaseUnits,
        estimatedFeeSun,
        principal: {
          ...candidateIdentity(pair.principal),
          onChainBalanceGroup: principalGroup,
        },
        fee: {
          ...candidateIdentity(pair.fee),
          onChainBalanceGroup: feeGroup,
          resourceRead: true,
          delegationStatus: delegation.status,
          activeEnergyStakeSun: String(delegation.activeEnergyStakeSun || '0'),
          activeBandwidthStakeSun: String(delegation.activeBandwidthStakeSun || '0'),
        },
        selectedAt: new Date().toISOString(),
        candidateSearchTruncated,
        transactionSpecificFeeCoverageVerified: false,
        sponsorConsentRecheckedForThisTransfer: false,
        separateBudgetsReserved: false,
        destinationAllowlistChecked: false,
        transactionAuthorizationVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      },
      candidateSearchTruncated,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      transactionSubmitted: false,
      userFundedFallbackAllowed: false,
      limitations: [
        'This is a read-only candidate selection. It does not reserve either budget or bind the selection to a signed transaction intent.',
        'The operator-supplied estimatedFeeSun is a comparison cap, not a validated transaction quote. Exact transaction energy, bandwidth, fee cap, and resource coverage must be rechecked against a built transaction.',
        'The observed delegation is pair-specific but does not prove it is sufficient for this exact transaction or that the sponsor has authorized this particular spend.',
        'Sponsor agreement, destination policy, per-transfer mandate, authorization nonce, and both budget reservations must be revalidated in the future submit path.',
        'No transaction is signed or broadcast; no user-funded fallback is permitted.',
      ],
    }
  }

  return fail(candidateSearchTruncated ? 'candidate-search-truncated' : 'no-dual-sponsor-pair-passed-preflight', {
    evaluatedPairs,
    blockers: [...blockers],
    candidateSearchTruncated,
  })
}
