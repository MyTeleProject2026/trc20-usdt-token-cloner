const NETWORKS = new Set(['nile', 'shasta'])
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const REFERENCE = /^[A-Za-z0-9._:-]{8,160}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/

function uint(value, { allowZero = true } = {}) {
  if (typeof value === 'string' && UINT.test(value) && (allowZero || value !== '0')) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (allowZero || value > 0)) return BigInt(value)
  return null
}

function validMandate(row) {
  return row
    && REFERENCE.test(row.mandateReference)
    && REFERENCE.test(row.sponsorReference)
    && NETWORKS.has(row.network)
    && ADDRESS.test(row.feeSponsorAddress)
    && ADDRESS.test(row.assetPrincipalAddress)
    && row.feeSponsorAddress !== row.assetPrincipalAddress
    && uint(row.energyBudgetUnits) !== null
    && uint(row.bandwidthBudgetUnits, { allowZero: false }) !== null
    && uint(row.perTransferEnergyUnits) !== null
    && uint(row.perTransferBandwidthUnits, { allowZero: false }) !== null
    && uint(row.perTransferEnergyUnits) <= uint(row.energyBudgetUnits)
    && uint(row.perTransferBandwidthUnits, { allowZero: false }) <= uint(row.bandwidthBudgetUnits, { allowZero: false })
}

/**
 * Server-only, operator-reviewed resource mandates. Each entry has exactly:
 * mandateReference|sponsorReference|network|feeSponsorAddress|assetPrincipalAddress|
 * energyBudgetUnits|bandwidthBudgetUnits|perTransferEnergyUnits|perTransferBandwidthUnits
 */
export function parseApprovedSponsorResourceMandates(env = process.env) {
  const raw = typeof env.SPONSOR_APPROVED_RESOURCE_MANDATES === 'string'
    ? env.SPONSOR_APPROVED_RESOURCE_MANDATES : ''
  return raw.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const fields = entry.split('|')
    if (fields.length !== 9) return null
    const [mandateReference, sponsorReference, network, feeSponsorAddress, assetPrincipalAddress,
      energyBudgetUnits, bandwidthBudgetUnits, perTransferEnergyUnits, perTransferBandwidthUnits] = fields
    const mandate = {
      mandateReference, sponsorReference, network, feeSponsorAddress, assetPrincipalAddress,
      energyBudgetUnits, bandwidthBudgetUnits, perTransferEnergyUnits, perTransferBandwidthUnits,
    }
    return validMandate(mandate) ? mandate : null
  }).filter(Boolean)
}

export function findApprovedSponsorResourceMandate({
  env = process.env,
  sponsorReference,
  network,
  feeSponsorAddress,
  assetPrincipalAddress,
} = {}) {
  if (typeof sponsorReference !== 'string' || !REFERENCE.test(sponsorReference)
    || !NETWORKS.has(network) || !ADDRESS.test(feeSponsorAddress || '')
    || !ADDRESS.test(assetPrincipalAddress || '')) return null
  return parseApprovedSponsorResourceMandates(env).find((item) =>
    item.sponsorReference === sponsorReference
      && item.network === network
      && item.feeSponsorAddress === feeSponsorAddress
      && item.assetPrincipalAddress === assetPrincipalAddress) || null
}

/**
 * Classify a receipt against the resource reservation made before wallet signing.
 * TRON's receipt reports the initiating account's Energy use separately from
 * total Energy; originEnergyUsage belongs to the contract deployer and is not
 * charged to the fee sponsor's delegated pool.
 *
 * A positive TRX fee is never silently booked as sponsor-covered resource usage.
 * The reservation remains held for manual review whenever evidence is incomplete,
 * a TRX burn occurred, or actual use exceeds the exact pre-sign reservation.
 */
export function evaluateSponsorResourceCostSettlement({ transfer, costs, reservation } = {}) {
  const manual = (reason) => ({ settled: false, status: 'manual-review', reason })
  if (!transfer || !costs || !reservation) return manual('settlement-input-missing')
  if (!NETWORKS.has(transfer.network)
    || costs.network !== transfer.network
    || String(costs.transactionHash || '').toLowerCase() !== String(transfer.transactionHash || '').toLowerCase()
    || String(reservation.transactionHash || '').toLowerCase() !== String(transfer.transactionHash || '').toLowerCase()
    || !/^[0-9a-f]{64}$/i.test(String(transfer.transactionHash || ''))
    || !Number.isSafeInteger(costs.blockNumber) || costs.blockNumber <= 0
    || costs.executionResult !== 'SUCCESS') return manual('solidified-transfer-identity-mismatch')

  if (reservation.status !== 'reserved'
    || reservation.feeSponsorAddress !== costs.feeSponsorAddress
    || reservation.assetPrincipalAddress !== transfer.sponsorAddress
    || reservation.network !== transfer.network
    || reservation.idempotencyKey !== transfer.idempotencyKey) return manual('resource-reservation-identity-mismatch')

  const snapshot = reservation.capacitySnapshot
  if (!snapshot || snapshot.resourceCapacityPreflightPassed !== true
    || snapshot.feeSponsorResourceSourceVerified !== true
    || snapshot.feeSponsorAddress !== reservation.feeSponsorAddress
    || snapshot.bandwidthCoverageSource !== 'exact-active-fee-sponsor-delegation-only'
    || (transfer.asset !== 'TRX' && snapshot.energyCoverageSource !== 'exact-active-fee-sponsor-delegation-only')) {
    return manual('exclusive-delegated-resource-source-not-proven')
  }

  const reportedFeeSun = uint(costs.reportedFeeSun)
  const energyFeeSun = uint(costs.energyFeeSun)
  const netFeeSun = uint(costs.netFeeSun)
  if (reportedFeeSun === null || energyFeeSun === null || netFeeSun === null) {
    return manual('solidified-fee-fields-incomplete')
  }
  if (reportedFeeSun > 0n || energyFeeSun > 0n || netFeeSun > 0n) {
    return manual('unexpected-trx-fee-burn-observed')
  }

  const energyUsed = transfer.asset === 'TRX' && costs.energyUsage == null ? 0n : uint(costs.energyUsage)
  const bandwidthUsed = uint(costs.netUsage, { allowZero: false })
  const energyReserved = uint(reservation.energyReservedUnits)
  const bandwidthReserved = uint(reservation.bandwidthReservedUnits, { allowZero: false })
  if (energyUsed === null || bandwidthUsed === null || energyReserved === null || bandwidthReserved === null) {
    return manual('solidified-resource-usage-incomplete')
  }
  if (energyUsed > energyReserved || bandwidthUsed > bandwidthReserved) {
    return manual('actual-resource-usage-exceeded-reservation')
  }
  if (transfer.asset === 'TRX' && energyUsed !== 0n) {
    return manual('unexpected-energy-use-for-native-transfer')
  }

  return {
    settled: true,
    status: 'settled',
    settlementReason: 'solidified-resource-usage-with-zero-trx-burn',
    network: transfer.network,
    transactionHash: String(transfer.transactionHash).toLowerCase(),
    blockNumber: costs.blockNumber,
    energyReservedUnits: energyReserved.toString(),
    bandwidthReservedUnits: bandwidthReserved.toString(),
    energyConsumedUnits: energyUsed.toString(),
    bandwidthConsumedUnits: bandwidthUsed.toString(),
    energyReleasedUnits: (energyReserved - energyUsed).toString(),
    bandwidthReleasedUnits: (bandwidthReserved - bandwidthUsed).toString(),
    reportedFeeSun: reportedFeeSun.toString(),
    energyFeeSun: energyFeeSun.toString(),
    netFeeSun: netFeeSun.toString(),
    feeSponsorResourceSource: 'verified-single-inbound-delegation-preflight',
    directFeeSponsorTrxDebitVerified: false,
  }
}
