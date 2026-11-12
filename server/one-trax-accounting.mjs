import { TronWeb } from 'tronweb'

const TESTNETS = Object.freeze({
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
})

export async function readOneTraxAccounting({
  env = process.env,
  tronWebFactory = (fullHost) => new TronWeb({ fullHost }),
} = {}) {
  const network = String(env.ONE_TRAX_NETWORK || '').trim().toLowerCase()
  const reserveAddress = String(env.ONE_TRAX_RESERVE_ADDRESS || '').trim()
  const contractAddress = String(env.ONE_TRAX_CONTRACT_ADDRESS || '').trim()
  const missing = []
  if (!TESTNETS[network]) missing.push('ONE_TRAX_NETWORK (nile or shasta)')
  if (!reserveAddress) missing.push('ONE_TRAX_RESERVE_ADDRESS')
  if (!contractAddress) missing.push('ONE_TRAX_CONTRACT_ADDRESS')
  if (missing.length) return { success: true, configured: false, network: network || null, missing }

  if (!TronWeb.isAddress(reserveAddress) || !TronWeb.isAddress(contractAddress)) {
    return { success: false, error: 'invalid-testnet-address' }
  }

  const tronWeb = tronWebFactory(TESTNETS[network])
  const token = await tronWeb.contract().at(contractAddress)
  const [reserveSunValue, supplyValue, decimalsValue] = await Promise.all([
    tronWeb.trx.getBalance(reserveAddress),
    token.totalSupply().call(),
    token.decimals().call(),
  ])
  const reserveSun = BigInt(String(reserveSunValue))
  const outstanding1TraxUnits = BigInt(String(supplyValue))
  const decimals = Number(decimalsValue)
  if (reserveSun < 0n || outstanding1TraxUnits < 0n || decimals !== 6) {
    return { success: false, error: 'unexpected-onchain-accounting-value' }
  }
  const surplusSun = reserveSun > outstanding1TraxUnits ? reserveSun - outstanding1TraxUnits : 0n
  const shortfallSun = outstanding1TraxUnits > reserveSun ? outstanding1TraxUnits - reserveSun : 0n
  const backingRatioBps = outstanding1TraxUnits === 0n
    ? null
    : ((reserveSun * 10000n) / outstanding1TraxUnits).toString()

  return {
    success: true,
    configured: true,
    network,
    reserve: {
      address: reserveAddress,
      asset: 'native-TRX',
      balanceSun: reserveSun.toString(),
      decimals: 6,
    },
    liability: {
      contractAddress,
      asset: '1TRAX',
      totalSupplyUnits: outstanding1TraxUnits.toString(),
      decimals,
    },
    reconciliation: {
      reserveAndLiabilityAreSeparate: true,
      surplusSun: surplusSun.toString(),
      shortfallSun: shortfallSun.toString(),
      backingRatioBasisPoints: backingRatioBps,
      target: '1 TRX reserve SUN per 1 1TRAX base unit',
      note: 'Read-only node snapshot; independently verify solidification and reserve ownership before relying on it. No reserve transfer or redemption is performed.',
    },
  }
}
