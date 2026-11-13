import { TronWeb } from 'tronweb'
import { isValidTronAddress } from './tron-address.mjs'

const MAINNET = 'https://api.trongrid.io'

export async function readOneTraxAccounting({
  env = process.env,
  tronWebFactory = (fullHost) => new TronWeb({ fullHost }),
} = {}) {
  const network = 'mainnet'
  const reserveAddress = String(env.ONE_TRAX_RESERVE_ADDRESS || '').trim()
  const contractAddress = String(env.ONE_TRAX_CONTRACT_ADDRESS || '').trim()
  const missing = []
  
  if (!reserveAddress) missing.push('ONE_TRAX_RESERVE_ADDRESS')
  if (!contractAddress) missing.push('ONE_TRAX_CONTRACT_ADDRESS')
  if (missing.length) return { success: true, configured: false, network, missing }

  if (!isValidTronAddress(reserveAddress) || !isValidTronAddress(contractAddress)) {
    return { success: false, error: 'invalid-mainnet-address' }
  }

  const tronWeb = tronWebFactory(MAINNET)
  const token = await tronWeb.contract().at(contractAddress)
  const [reserveSunValue, supplyValue, decimalsValue, nameValue, symbolValue, vaultAddressValue] = await Promise.all([
    tronWeb.trx.raw.getBalance(reserveAddress),
    token.totalSupply().call(),
    token.decimals().call(),
    token.name().call(),
    token.symbol().call(),
    token.reserveVault().call(),
  ])
  const rawVaultAddress = String(vaultAddressValue || '')
  let reserveVaultAddress = rawVaultAddress
  if (rawVaultAddress && !rawVaultAddress.startsWith('T')) {
    try { reserveVaultAddress = tronWeb.address.fromHex(rawVaultAddress.replace(/^0x/, '')) } catch { reserveVaultAddress = '' }
  }
  if (nameValue !== 'TRӾ' || symbolValue !== 'TRX' || Number(decimalsValue) !== 6 ||
      !isValidTronAddress(reserveVaultAddress) || reserveVaultAddress !== reserveAddress) {
    return { success: false, error: 'mainnet-token-metadata-or-vault-mismatch' }
  }
  const vault = await tronWeb.contract().at(reserveVaultAddress)
  const authorizedToken = await vault.authorizedToken().call()
  if (String(authorizedToken) !== contractAddress &&
      tronWeb.address.toHex(String(authorizedToken)) !== tronWeb.address.toHex(contractAddress)) {
    return { success: false, error: 'mainnet-vault-token-authorization-mismatch' }
  }
  const reserveSun = BigInt(String(reserveSunValue))
  const outstanding1TraxUnits = BigInt(String(supplyValue))
  const decimals = Number(decimalsValue)
  if (reserveSun < 0n || outstanding1TraxUnits < 0n) {
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
      authorizedToken: String(authorizedToken),
      asset: 'native-TRX',
      balanceSun: reserveSun.toString(),
      decimals: 6,
    },
    liability: {
      contractAddress,
      name: nameValue,
      symbol: symbolValue,
      asset: 'TRX (TRӾ token; not native TRX)',
      totalSupplyUnits: outstanding1TraxUnits.toString(),
      decimals,
    },
    reconciliation: {
      reserveAndLiabilityAreSeparate: true,
      surplusSun: surplusSun.toString(),
      shortfallSun: shortfallSun.toString(),
      backingRatioBasisPoints: backingRatioBps,
      target: '1 TRX reserve SUN per 1 1TRAX base unit',
      note: 'Read-only TRON Mainnet node snapshot; this custom TRC-20 is not native TRX. Independently verify contract bytecode, ownership, and reserve custody. No reserve transfer or redemption is performed.',
    },
  }
}
