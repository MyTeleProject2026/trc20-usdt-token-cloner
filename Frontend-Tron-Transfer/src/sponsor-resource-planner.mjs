const SUN = 1_000_000n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function positiveInteger(value, label) {
  const text = String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(label + ' must be a non-negative integer.')
  const parsed = BigInt(text)
  if (parsed > MAX_SAFE) throw new Error(label + ' exceeds the supported planning range.')
  return parsed
}

function estimateStakeSun(resource, deficit, network) {
  const limit = positiveInteger(resource === 'ENERGY' ? network.totalEnergyLimit : network.totalNetLimit, 'Network resource limit')
  const weight = positiveInteger(resource === 'ENERGY' ? network.totalEnergyWeight : network.totalNetWeight, 'Network resource weight')
  if (limit === 0n || weight === 0n) return null
  const numerator = deficit * weight * SUN * 115n
  const denominator = limit * 100n
  const estimate = (numerator + denominator - 1n) / denominator
  return estimate > 0n && estimate <= MAX_SAFE ? estimate : null
}

/**
 * Produces exactly one next Sponsor action. It never signs or broadcasts.
 * If fresh delegated capacity is insufficient, stake only the incremental
 * amount and require a new live read before the subsequent delegation.
 */
export function planSponsorResourceProvisioning({
  resource,
  target,
  ownerAvailable,
  maxDelegatableSun,
  sponsorBalanceSun,
  protectedReserveSun,
  network,
  stakingEnabled,
  maxStakeSun,
}) {
  if (!['ENERGY', 'BANDWIDTH'].includes(resource)) return { ready: false, action: null, reason: 'unsupported-resource' }
  let targetValue, ownerValue, delegatable, balance, reserve, stakeCap
  try {
    targetValue = positiveInteger(target, 'Owner resource target')
    ownerValue = positiveInteger(ownerAvailable, 'Owner available resource')
    delegatable = positiveInteger(maxDelegatableSun, 'Sponsor delegation ceiling')
    balance = positiveInteger(sponsorBalanceSun, 'Sponsor TRX balance')
    reserve = positiveInteger(protectedReserveSun, 'Protected Sponsor reserve')
    stakeCap = positiveInteger(maxStakeSun, 'Sponsor stake cap')
  } catch (error) {
    return { ready: false, action: null, reason: 'invalid-live-input', message: error.message }
  }
  if (targetValue === 0n) return { ready: false, action: null, reason: 'invalid-target' }
  const deficit = targetValue > ownerValue ? targetValue - ownerValue : 0n
  if (deficit === 0n) return { ready: true, action: null, reason: 'target-met', deficit: '0' }

  let requiredStake
  try { requiredStake = estimateStakeSun(resource, deficit, network || {}) }
  catch (error) { return { ready: false, action: null, reason: 'network-resource-data-invalid', message: error.message, deficit: deficit.toString() } }
  if (requiredStake === null) return { ready: false, action: null, reason: 'network-resource-weight-unavailable', deficit: deficit.toString() }

  if (delegatable >= requiredStake) {
    return {
      ready: true, action: 'delegate', resource, amountSun: requiredStake.toString(),
      deficit: deficit.toString(), estimatedStakeSun: requiredStake.toString(),
      reason: 'existing-stake-can-cover-target',
    }
  }

  const additionalStake = requiredStake - delegatable
  if (stakingEnabled !== true) return {
    ready: false, action: null, resource, deficit: deficit.toString(),
    estimatedStakeSun: requiredStake.toString(), reason: 'staking-disabled-or-existing-capacity-insufficient',
    availableDelegationSun: delegatable.toString(),
  }
  if (additionalStake > stakeCap) return {
    ready: false, action: null, resource, deficit: deficit.toString(),
    estimatedStakeSun: requiredStake.toString(), additionalStakeSun: additionalStake.toString(),
    reason: 'incremental-stake-exceeds-configured-cap',
  }
  if (balance < additionalStake + reserve) return {
    ready: false, action: null, resource, deficit: deficit.toString(),
    estimatedStakeSun: requiredStake.toString(), additionalStakeSun: additionalStake.toString(),
    reason: 'insufficient-sponsor-balance-after-protected-reserve',
    requiredBalanceSun: (additionalStake + reserve).toString(),
  }
  return {
    ready: true, action: 'stake', resource, amountSun: additionalStake.toString(),
    deficit: deficit.toString(), estimatedStakeSun: requiredStake.toString(),
    availableDelegationSun: delegatable.toString(),
    reason: 'stake-increment-needed-before-delegation',
    requiresFreshReadBeforeDelegation: true,
  }
}

export const __plannerInternals = Object.freeze({ estimateStakeSun })
