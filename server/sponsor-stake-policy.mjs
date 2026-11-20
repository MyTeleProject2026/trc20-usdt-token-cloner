const UINT = /^(0|[1-9][0-9]{0,15})$/
const SUN_PER_TRX = 1_000_000

function decimalTrxToSun(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const sun = BigInt(whole) * BigInt(SUN_PER_TRX) + BigInt((fraction + '000000').slice(0, 6))
  return sun > 0n ? sun : null
}

/**
 * Pure, side-effect-free Stake 2.0 policy planner.
 * Amounts are decimal TRX strings from the UI and become exact SUN integers.
 * This function never signs, broadcasts, or changes chain state.
 */
export function planSponsorStake({ amountTrx, resource, sponsorBalanceSun, protectedReserveTrx = '2', maximumAutomaticStakeTrx = '10', sponsorAddress, ownerAddress } = {}) {
  if (typeof sponsorAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(sponsorAddress)
    || typeof ownerAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(ownerAddress)
    || sponsorAddress === ownerAddress) {
    return { ready: false, status: 'invalid-or-non-independent-wallet-identities' }
  }
  if (!['ENERGY', 'BANDWIDTH'].includes(resource)) return { ready: false, status: 'invalid-stake-resource' }
  const amountSun = decimalTrxToSun(amountTrx)
  const reserveSun = decimalTrxToSun(protectedReserveTrx)
  const maximumSun = decimalTrxToSun(maximumAutomaticStakeTrx)
  if (amountSun === null || reserveSun === null || maximumSun === null
    || typeof sponsorBalanceSun !== 'string' || !UINT.test(sponsorBalanceSun)) {
    return { ready: false, status: 'invalid-stake-amount-or-balance' }
  }
  const balance = BigInt(sponsorBalanceSun)
  if (amountSun < BigInt(SUN_PER_TRX)) return { ready: false, status: 'below-application-minimum-one-trx' }
  if (amountSun > maximumSun) return { ready: false, status: 'exceeds-automatic-stake-ceiling' }
  if (balance < reserveSun || amountSun > balance - reserveSun) {
    return { ready: false, status: 'insufficient-spendable-balance-after-protected-reserve' }
  }
  return {
    ready: true,
    status: 'stake-policy-preflight-passed-no-transaction-created',
    network: 'mainnet',
    sponsorAddress,
    ownerAddress,
    resource,
    amountSun: amountSun.toString(),
    amountTrx: (Number(amountSun) / SUN_PER_TRX).toFixed(6),
    sponsorBalanceSun: balance.toString(),
    protectedReserveSun: reserveSun.toString(),
    remainingLiquidBalanceSun: (balance - amountSun).toString(),
    requiresOwnerApproval: true,
    transactionCreated: false,
    signed: false,
    broadcast: false,
  }
}
