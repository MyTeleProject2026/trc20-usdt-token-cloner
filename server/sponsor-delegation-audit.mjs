import { isValidTronAddress } from './tron-address.mjs'

const NETWORKS = new Set(['mainnet', 'shasta', 'nile'])
const TX_PATTERN = /^[0-9a-f]{64}$/i
const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/

/**
 * Confirms that the exact configured fee-sponsor/principal pair has persisted
 * independently verified delegation transactions for both Energy and
 * Bandwidth. This complements (and never replaces) the live solidified-state
 * snapshot. An incomplete or truncated history is deliberately inconclusive.
 */
export function verifySponsorDelegationTransactionAudit({
  network,
  feeSponsorAddress,
  principalSponsorAddress,
  liveSnapshot,
  auditResult,
  limit = 100,
} = {}) {
  const fail = (status) => ({
    verified: false,
    status,
    resourceTypes: [],
    transactionCount: 0,
  })

  if (!NETWORKS.has(network)
    || !isValidTronAddress(feeSponsorAddress)
    || !isValidTronAddress(principalSponsorAddress)
    || feeSponsorAddress === principalSponsorAddress
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail('invalid-delegation-audit-identity')
  }

  if (liveSnapshot?.success !== true
    || liveSnapshot.network !== network
    || liveSnapshot.fromAddress !== feeSponsorAddress
    || liveSnapshot.toAddress !== principalSponsorAddress
    || !UINT_PATTERN.test(String(liveSnapshot.activeEnergyStakeSun ?? ''))
    || !UINT_PATTERN.test(String(liveSnapshot.activeBandwidthStakeSun ?? ''))
    || BigInt(liveSnapshot.activeEnergyStakeSun) <= 0n
    || BigInt(liveSnapshot.activeBandwidthStakeSun) <= 0n) {
    return fail('live-delegation-state-not-verified')
  }

  if (auditResult?.success !== true || !Array.isArray(auditResult.delegations)) {
    return fail('delegation-transaction-audit-unavailable')
  }
  if (auditResult.delegations.length >= limit) {
    return fail('delegation-transaction-audit-history-truncated')
  }

  const matching = auditResult.delegations.filter((row) =>
    row?.network === network
    && row?.sponsorAddress === feeSponsorAddress
    && row?.receiverAddress === principalSponsorAddress)

  const verifiedTypes = new Set()
  const transactionIds = new Set()
  for (const row of matching) {
    if (row.status !== 'verified-on-chain'
      || !['ENERGY', 'BANDWIDTH'].includes(row.resourceType)
      || typeof row.transactionId !== 'string' || !TX_PATTERN.test(row.transactionId)
      || !Number.isSafeInteger(row.blockNumber) || row.blockNumber <= 0
      || typeof row.stakeEquivalentSun !== 'string' || !/^[1-9][0-9]{0,77}$/.test(row.stakeEquivalentSun)) {
      return fail('delegation-transaction-audit-record-invalid')
    }
    const transactionId = row.transactionId.toLowerCase()
    if (transactionIds.has(transactionId)) return fail('delegation-transaction-audit-duplicate')
    transactionIds.add(transactionId)
    const auditedStake = BigInt(row.stakeEquivalentSun)
    const liveStake = BigInt(row.resourceType === 'ENERGY'
      ? liveSnapshot.activeEnergyStakeSun
      : liveSnapshot.activeBandwidthStakeSun)
    if (auditedStake > liveStake) return fail('audited-delegation-stake-exceeds-current-allocation')
    verifiedTypes.add(row.resourceType)
  }

  const resourceTypes = ['ENERGY', 'BANDWIDTH'].filter((type) => verifiedTypes.has(type))
  if (resourceTypes.length !== 2) {
    return {
      verified: false,
      status: 'delegation-transaction-audit-missing-resource-types',
      resourceTypes,
      transactionCount: matching.length,
    }
  }

  return {
    verified: true,
    status: 'verified-energy-and-bandwidth-delegation-transactions',
    resourceTypes,
    transactionCount: matching.length,
  }
}
