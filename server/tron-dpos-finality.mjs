const ACTIVE_WITNESS_ADDRESS = /^41[0-9a-f]{40}$/i
const DEFAULT_SOLIDIFIED_THRESHOLD_PERCENT = 70
const DEFAULT_ACTIVE_WITNESS_COUNT = 27

function parseHeight(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function parseActiveWitnessMap(payload, provider) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error
    || !Array.isArray(payload.witnesses)) {
    return { ok: false, reason: 'solidified-witness-list-unavailable', provider }
  }

  const active = payload.witnesses.filter((witness) => witness?.isJobs === true)
  if (active.length !== DEFAULT_ACTIVE_WITNESS_COUNT) {
    return {
      ok: false,
      reason: 'solidified-active-witness-count-invalid',
      provider,
      activeWitnessCount: active.length,
    }
  }

  const map = new Map()
  for (const witness of active) {
    const address = typeof witness?.address === 'string' ? witness.address.toLowerCase() : ''
    const latestBlockNumber = parseHeight(witness?.latestBlockNum)
    if (!ACTIVE_WITNESS_ADDRESS.test(address) || latestBlockNumber === null || map.has(address)) {
      return { ok: false, reason: 'solidified-active-witness-record-invalid', provider }
    }
    map.set(address, latestBlockNumber)
  }

  return { ok: true, map }
}

/**
 * Recomputes java-tron's DPoS solidified height from two SolidityNode
 * ListWitnesses snapshots. For every active SR, the lower latestBlockNum
 * reported by the two providers is used; active-set disagreement is rejected.
 *
 * This is a provider-state cross-check, not a cryptographic state-trie proof.
 */
export function verifyTronDposSolidification({
  primaryWitnessList,
  secondaryWitnessList,
  expectedBlockNumber,
  thresholdPercent = DEFAULT_SOLIDIFIED_THRESHOLD_PERCENT,
  expectedActiveWitnessCount = DEFAULT_ACTIVE_WITNESS_COUNT,
} = {}) {
  const fail = (reason, extra = {}) => ({ verified: false, reason, ...extra })
  if (!Number.isSafeInteger(expectedBlockNumber) || expectedBlockNumber < 1
    || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent >= 100
    || !Number.isInteger(expectedActiveWitnessCount) || expectedActiveWitnessCount < 1
    || expectedActiveWitnessCount > 127) {
    return fail('solidified-witness-proof-input-invalid')
  }

  const primary = parseActiveWitnessMap(primaryWitnessList, 'primary')
  if (!primary.ok) return fail(primary.reason, {
    failedProvider: primary.provider,
    ...(primary.activeWitnessCount === undefined ? {} : { activeWitnessCount: primary.activeWitnessCount }),
  })
  const secondary = parseActiveWitnessMap(secondaryWitnessList, 'secondary')
  if (!secondary.ok) return fail(secondary.reason, {
    failedProvider: secondary.provider,
    ...(secondary.activeWitnessCount === undefined ? {} : { activeWitnessCount: secondary.activeWitnessCount }),
  })

  if (primary.map.size !== expectedActiveWitnessCount || secondary.map.size !== expectedActiveWitnessCount) {
    return fail('solidified-active-witness-count-invalid')
  }

  const primaryAddresses = [...primary.map.keys()].sort()
  const secondaryAddresses = [...secondary.map.keys()].sort()
  if (primaryAddresses.length !== secondaryAddresses.length
    || primaryAddresses.some((address, index) => address !== secondaryAddresses[index])) {
    return fail('solidified-active-witness-set-disagreement')
  }

  const conservativeHeights = primaryAddresses.map((address) =>
    Math.min(primary.map.get(address), secondary.map.get(address)))
  const sortedHeights = [...conservativeHeights].sort((left, right) => left - right)
  // Matches java-tron DposService.updateSolidBlock(): list index is the
  // integer-truncated active-count * (1 - thresholdPercent / 100).
  const position = Math.floor(expectedActiveWitnessCount * (1 - thresholdPercent / 100))
  if (position < 0 || position >= sortedHeights.length) {
    return fail('solidified-threshold-position-invalid')
  }
  const solidifiedHeight = sortedHeights[position]
  const supportingWitnessCount = conservativeHeights.filter((height) => height >= expectedBlockNumber).length
  const requiredSupportingWitnessCount = expectedActiveWitnessCount - position

  if (supportingWitnessCount < requiredSupportingWitnessCount || solidifiedHeight < expectedBlockNumber) {
    return fail('target-block-not-solidified-by-active-witness-threshold', {
      expectedBlockNumber,
      solidifiedHeight,
      activeWitnessCount: expectedActiveWitnessCount,
      requiredSupportingWitnessCount,
      supportingWitnessCount,
      thresholdPercent,
    })
  }

  return {
    verified: true,
    status: 'active-witness-solidification-threshold-recomputed',
    expectedBlockNumber,
    solidifiedHeight,
    activeWitnessCount: expectedActiveWitnessCount,
    requiredSupportingWitnessCount,
    supportingWitnessCount,
    thresholdPercent,
    providerAgreement: 'same-27-active-witness-addresses; per-witness lower latestBlockNum used',
    verificationMethod: 'java-tron-dpos-active-witness-latest-block-threshold-recomputation',
  }
}
