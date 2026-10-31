import { createSponsorRoleFundingReader } from './sponsor-roles.mjs'
import { isSponsorTokenContractAllowed } from './database.mjs'
import { isValidTronAddress } from './tron-address.mjs'

const NETWORKS = new Set(['mainnet', 'nile', 'shasta'])
const ASSETS = new Set(['TRX', 'USDT'])
const UINT_PATTERN = /^[1-9][0-9]{0,77}$/

function scopedRoleEnvironment(env, network, feeAddress, principalAddress) {
  const feeKey = 'SPONSOR_FEE_' + network.toUpperCase() + '_ADDRESS'
  const principalKey = 'SPONSOR_ASSET_' + network.toUpperCase() + '_ADDRESS'
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === feeKey) return feeAddress
      if (property === principalKey) return principalAddress
      return Reflect.get(target, property, receiver)
    },
  })
}

function exactPairFunding(roleFunding, network, feeAddress, principalAddress) {
  const feeSnapshot = roleFunding?.fundingSnapshots?.networkFeeSponsor
  const principalSnapshot = roleFunding?.fundingSnapshots?.assetPrincipalSponsor
  const fresh = (snapshot, address) => {
    const ageMs = Date.now() - Date.parse(snapshot?.checkedAt || '')
    return snapshot?.status === 'solidified-sponsor-balances-read'
      && snapshot.onChainBalanceRead === true
      && snapshot.network === network
      && snapshot.sponsorAddress === address
      && snapshot.source === 'Tatum TRON SolidityNode account and constant-contract queries'
      && snapshot.cache?.status === 'fresh'
      && Number.isFinite(ageMs) && ageMs >= -5000 && ageMs <= 15000
  }
  if (!fresh(feeSnapshot, feeAddress) || !fresh(principalSnapshot, principalAddress)) {
    return { success: false, reason: 'fresh-role-specific-funding-snapshots-required' }
  }
  const feeRole = roleFunding?.roles?.networkFeeSponsor
  const delegation = roleFunding?.feeSponsorDelegationToPrincipal
  const delegationActive = delegation?.success === true
    && delegation.status === 'solidified-delegation-state-read'
    && delegation.fromAddress === feeAddress
    && delegation.toAddress === principalAddress
    && ((/^[1-9][0-9]*$/.test(String(delegation.activeEnergyStakeSun || '0')))
      || (/^[1-9][0-9]*$/.test(String(delegation.activeBandwidthStakeSun || '0'))))
  if (feeRole?.resourceStatus?.resourceRead !== true || !delegationActive) {
    return { success: false, reason: 'active-fee-to-principal-resource-delegation-not-observed' }
  }
  return { success: true, fundingSnapshots: roleFunding.fundingSnapshots, delegation }
}

/**
 * Creates only a short-lived internal accounting reservation. It does not
 * verify a transaction-specific fee quote, acquire cryptographic consent, sign,
 * or broadcast. Those actions remain separate blocked milestones.
 */
export async function reserveSponsorOrganizationPayoutIntent({
  store,
  env = process.env,
  input,
  readRoleFunding,
} = {}) {
  const fail = (reason, extra = {}) => ({
    success: false, reason, status: reason, intent: null,
    transactionSubmitted: false, canSubmitSponsoredTransfer: false,
    submissionEnabled: false, userFundedFallbackAllowed: false, ...extra,
  })
  const {
    idempotencyKey, network, asset, tokenContract = null, receiverAddress,
    amountBaseUnits, feeCapSun, principalLinkId, feeLinkId,
  } = input || {}
  const configuredContracts = String(env['SPONSOR_USDT_' + String(network || '').toUpperCase() + '_CONTRACTS'] || '')
    .split(',').map((item) => item.trim()).filter(Boolean)
  if (!store || typeof store.listBudgetLinks !== 'function' || typeof store.reservePayoutIntent !== 'function') {
    return fail('sponsor-registry-store-unavailable')
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || !NETWORKS.has(network) || !ASSETS.has(asset)
    || (asset === 'TRX' ? tokenContract !== null
      : !isValidTronAddress(tokenContract)
        || !isSponsorTokenContractAllowed(network, asset, tokenContract, configuredContracts))
    || !isValidTronAddress(receiverAddress)
    || !UINT_PATTERN.test(amountBaseUnits || '') || !UINT_PATTERN.test(feeCapSun || '')
    || typeof principalLinkId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(principalLinkId)
    || typeof feeLinkId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(feeLinkId)
    || principalLinkId === feeLinkId) {
    return fail('invalid-payout-intent')
  }

  let linkResult
  try {
    linkResult = await store.listBudgetLinks({ network, limit: 100 })
  } catch {
    return fail('sponsor-budget-link-ledger-unavailable')
  }
  if (!linkResult?.success || !Array.isArray(linkResult.links)) {
    return fail(linkResult?.reason || 'sponsor-budget-link-ledger-unavailable')
  }
  if (linkResult.links.length >= 100) return fail('sponsor-budget-link-ledger-truncated')
  const principal = linkResult.links.find((link) => link.id === principalLinkId)
  const fee = linkResult.links.find((link) => link.id === feeLinkId)
  const eligible = (link, role, purpose) => link?.linkCurrentlyActive === true
    && link.linkStatus === 'active'
    && link.organizationStatus === 'approved'
    && link.accountStatus === 'verified'
    && link.budgetStatus === 'active'
    && link.agreementScopeVerified === true
    && link.network === network
    && link.role === role
    && link.purpose === purpose
  if (!eligible(principal, 'asset-principal', 'asset-grant')
    || !eligible(fee, 'network-fee', 'network-fee')
    || principal.asset !== asset || (principal.tokenContract || null) !== tokenContract
    || fee.asset !== 'TRX' || fee.tokenContract != null
    || principal.sponsorAddress === fee.sponsorAddress) {
    return fail('approved-role-specific-principal-and-fee-budgets-with-distinct-wallets-required')
  }

  let roleFunding
  try {
    if (typeof readRoleFunding === 'function') {
      roleFunding = await readRoleFunding(network, fee.sponsorAddress, principal.sponsorAddress)
    } else {
      const roleEnv = scopedRoleEnvironment(env, network, fee.sponsorAddress, principal.sponsorAddress)
      const reader = createSponsorRoleFundingReader({ env: roleEnv })
      roleFunding = await reader(network, { refresh: true })
    }
  } catch {
    return fail('sponsor-role-chain-read-failed')
  }
  const funding = exactPairFunding(roleFunding, network, fee.sponsorAddress, principal.sponsorAddress)
  if (!funding.success) return fail(funding.reason)

  let reserved
  try {
    reserved = await store.reservePayoutIntent({
      idempotencyKey, network, asset, tokenContract, receiverAddress,
      amountBaseUnits, feeCapSun, principalLinkId, feeLinkId,
      fundingSnapshots: funding.fundingSnapshots,
    })
  } catch {
    return fail('dual-sponsor-reservation-unavailable')
  }
  if (!reserved?.success) return fail(reserved?.reason || 'dual-sponsor-reservation-unavailable')
  return {
    success: true,
    status: reserved.status,
    intent: {
      id: reserved.intentId,
      idempotencyKey,
      intentDigest: reserved.intentDigest,
      network, asset, tokenContract, receiverAddress, amountBaseUnits, feeCapSun,
      principalBudgetLinkId: principalLinkId,
      feeBudgetLinkId: feeLinkId,
      expiresAt: reserved.expiresAt,
    },
    duplicate: reserved.duplicate === true,
    transactionSpecificFeeCoverageVerified: false,
    sponsorAuthorizationVerified: false,
    transactionSubmitted: false,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    userFundedFallbackAllowed: false,
    limitations: [
      'Both budget caps are reserved internally in PostgreSQL; no funds or Energy are locked on-chain.',
      'feeCapSun is only a maximum accounting reservation, not a transaction-specific fee or Energy/Bandwidth quote.',
      'The intent is pending independent sponsor authorization. No signature is accepted or verified by this endpoint.',
      'No transaction is built, signed, submitted, or broadcast, and this reservation does not authorize a payout.',
    ],
  }
}

